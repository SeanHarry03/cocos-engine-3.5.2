# Cocos Creator 3.5.2 自定义引擎改动说明

本文档记录当前自定义引擎中为 `Sprite.Type.SIMPLE` 增加的共享节点渲染逻辑。

目标是让多个 copy 节点复用 source 节点的 Sprite 静态渲染数据，减少每个 copy 重复计算 `SpriteFrame`、局部顶点、UV、材质和纹理状态的成本。当前实现仍然基于 Cocos 原有 2D CPU batching，因此每个 copy 仍需要自己的 `renderData/chunk`，也仍需要根据自己的 `worldMatrix` 写入最终顶点。

## 1. 涉及脚本

### 引擎源码

- `cocos/core/scene-graph/node.ts`
  - 增加共享关系字段。
  - 增加 `addCopyChildren()` / `removeCopyChildren()`。
  - 在节点销毁时清理 source 与 copy 的引用关系。

- `cocos/2d/renderer/batcher-2d.ts`
  - 在 `walk()` 中识别 copy 节点。
  - 增加 `walkShare()`，校验 source/copy 都是有效 `Sprite.Type.SIMPLE`。
  - 增加 `commitSharedComp()`，使用 source 的材质/纹理状态提交 copy 的渲染数据。
  - 调整共享节点 opacity 更新，避免 shared copy 每帧强制 `updateOpacity()`。

- `cocos/2d/renderer/i-batcher.ts`
  - 给 `IBatcher` 增加 `commitSharedComp()` 接口声明。

- `cocos/2d/framework/renderable-2d.ts`
  - 暴露 `assembler` getter，允许 `Batcher2D.walkShare()` 取得 source Sprite 当前 assembler。

- `cocos/2d/assembler/sprite/simple.ts`
  - 增加 `fillSharedBuffers()`。
  - 将 source 的 SIMPLE 局部顶点、UV、材质、纹理状态同步给 copy。
  - copy 使用自己的 `renderData/chunk/color/opacity/worldMatrix`。
  - 增加 `_sharedSimpleState` 缓存，避免每帧全量同步和强制 `vertDirty`。

### 项目测试脚本

- `D:/CocosProject/evil-spiritTiledMap/assets/ShareNode/SpriteTest.ts`
  - 增加普通 Sprite 与共享 Copy 的 A/B 性能统计。
  - 统计 `frameTime`、`Renderer(ms)`、`drawCalls`、`batches`、`instances`。

## 2. 原版 Sprite SIMPLE 渲染链路

原版 Cocos Creator 3.5.2 的 2D Sprite SIMPLE 主要流程：

```text
Batcher2D.walk(node)
    -> render.updateAssembler(batcher)
        -> assembler.updateRenderData(sprite)
            -> dynamicAtlasManager.packToDynamicAtlas(sprite, frame)
            -> simple.updateUVs(sprite)
            -> simple.updateVertexData(sprite)       // renderData.vertDirty 时
            -> renderData.updateRenderData(sprite, frame)
        -> Sprite._render(batcher)
            -> batcher.commitComp(sprite, renderData, frame, assembler, null)
                -> assembler.fillBuffers(sprite, batcher)
                    -> simple.updateWorldVerts(sprite, chunk)
                    -> 写入 index buffer
```

关键点：

- `updateRenderData()` 负责更新静态或半静态状态，例如 UV、局部顶点、纹理、材质、hash。
- `fillBuffers()` 负责使用当前节点自己的 `worldMatrix` 把局部顶点写成世界顶点，并写入 index。
- 静止节点不会每帧重算世界顶点，只有 `node.hasChangedFlags` 或 `renderData.vertDirty` 时才更新。

## 3. 当前共享节点渲染链路

共享 copy 节点通过 `Node.addCopyChildren(copyNode)` 建立关系。

```text
sourceNode.addCopyChildren(copyNode)
    -> copyNode._sharedRenderSource = sourceNode
    -> sourceNode.copyChidrens 记录 copyNode

Batcher2D.walk(copyNode)
    -> node._sharedRenderSource 存在
    -> Batcher2D.walkShare(copyNode, sourceNode)
        -> 校验 source/copy 都是 Sprite
        -> 校验 source/copy 都是 Sprite.Type.SIMPLE
        -> 校验 source 有 spriteFrame / texture / material
        -> sourceRender.assembler.fillSharedBuffers(sourceRender, copyRender, batcher)
            -> 同步 source 的 SIMPLE 共享数据到 copyRenderData
            -> batcher.commitSharedComp(sourceRender, copyRender, copyRenderData, frame, assembler, null)
                -> assembler.fillBuffers(copySprite, batcher)
```

共享路径不再调用：

```text
copySprite.updateAssembler()
copyAssembler.updateRenderData(copySprite)
```

而是直接由 source 的 SIMPLE assembler 执行：

```text
fillSharedBuffers(sourceSprite, copySprite, batcher)
```

## 4. 共享与非共享数据

### 共享 source 的数据

这些数据来自 source Sprite：

- `SpriteFrame`
- `Texture`
- `Material`
- `blendHash`
- SIMPLE 模式下的局部顶点范围：
  - `data[0].x`
  - `data[0].y`
  - `data[1].x`
  - `data[1].y`
- UV：
  - `frame.uv`

### copy 自己保留的数据

这些数据必须属于 copy 自己：

- `Node`
- `worldMatrix`
- `layer`
- `color`
- 级联 opacity
- `renderData`
- `chunk`
- 最终写入 MeshBuffer 的世界顶点

copy 仍然需要自己的 `renderData/chunk`，因为当前 2D batching 最终还是要为每个显示实例写入独立顶点。共享 SIMPLE 数据不是 GPU Instancing。

## 5. `fillSharedBuffers()` 数据对照

文件：`cocos/2d/assembler/sprite/simple.ts`

### 5.1 source renderData 准备

如果 source 的 `renderData` 不存在，则通过 SIMPLE assembler 的 `createData(sourceSprite)` 创建。

如果 source renderData 有以下 dirty 状态，则先按原版流程更新 source：

```text
vertDirty
passDirty
textureDirty
nodeDirty
hashDirty
```

对应原版：

```text
assembler.updateRenderData(sourceSprite)
```

这一步保证 copy 读取到的是 source 最新的局部顶点、UV、材质、纹理、hash。

### 5.2 copy renderData 准备

copy 如果还没有 `renderData`，也会通过 `createData(copySprite)` 创建。

这是必要的。copy 不共享 source 的 `chunk`，否则多个 copy 会写同一段顶点缓存，位置、颜色、透明度会互相污染。

### 5.3 局部顶点同步

SIMPLE Sprite 的局部顶点数据由两个点描述：

```text
data[0] = left bottom
data[1] = right top
```

共享路径会把 source 的这两个点复制给 copy：

```text
copy.data[0].x = source.data[0].x
copy.data[0].y = source.data[0].y
copy.data[1].x = source.data[1].x
copy.data[1].y = source.data[1].y
```

这对应原版 `simple.updateVertexData(sprite)` 的结果。

当前实现增加了 `_sharedSimpleState` 缓存：只有 source 局部顶点变化时才复制，并把 `copyRenderData.vertDirty = true`。静态节点不会再每帧强制 dirty。

### 5.4 UV 同步

共享路径读取 source 的 `frame.uv`，写入 copy chunk 的 UV 槽位：

```text
vData[3],  vData[4]
vData[12], vData[13]
vData[21], vData[22]
vData[30], vData[31]
```

这对应原版 `simple.updateUVs(sprite)` 的结果。

当前实现同样通过 `_sharedSimpleState` 缓存 UV，只有 UV 变化时才写入。

### 5.5 material / texture / layer / hash 同步

共享路径使用 source 的材质和纹理，但使用 copy 的 layer：

```text
copyRenderData.updatePass(sourceSprite)
copyRenderData.updateTexture(sourceFrame)
copyRenderData.updateNode(copySprite)
copyRenderData.updateHash()
```

当前实现不会每帧无条件调用这些方法，而是在以下情况才更新：

- `passDirty`
- `textureDirty`
- `nodeDirty`
- `hashDirty`
- source material 变化
- source blendHash 变化
- source frame 变化
- source texture hash 变化
- copy layer 变化

### 5.6 color 与 opacity

copy 的颜色不共享 source，仍然使用 copy 自己的 `Sprite.color`。

`fillSharedBuffers()` 会在 copy color 首次同步或发生变化时调用：

```text
simple.updateColor(copySprite)
```

并标记：

```text
copyRenderData._sharedOpacityDirty = true
```

随后 `Batcher2D.walk()` 会在必要时调用：

```text
updateOpacity(copyRenderData, cascadedOpacity)
```

这样可以保留父级透明度和 copy 自身透明度的级联结果，同时避免 shared copy 每帧都强制写 alpha。

### 5.7 worldMatrix

worldMatrix 不共享。

最终仍然进入原版 SIMPLE 的：

```text
simple.fillBuffers(copySprite, batcher)
```

里面继续按原版判断：

```text
if (copyNode.hasChangedFlags || copyRenderData.vertDirty) {
    updateWorldVerts(copySprite, copyRenderData.chunk)
    copyRenderData.vertDirty = false
}
```

因此 copy 的位置、旋转、缩放仍然由 copy 自己的节点控制。

## 6. Batcher2D 改动说明

文件：`cocos/2d/renderer/batcher-2d.ts`

### 6.1 `walk()` 分支

原版：

```text
render.updateAssembler(this)
```

共享 copy：

```text
this.walkShare(node, node._sharedRenderSource)
```

非共享节点保持原版流程。

### 6.2 `walkShare()`

`walkShare(copyNode, sourceNode)` 负责做渲染前校验：

- source 组件必须是 `Sprite`
- copy 组件必须是 `Sprite`
- source/copy 都必须是 `Sprite.Type.SIMPLE`
- source/copy 都必须启用
- copy alpha 必须大于 0
- source 必须有 `spriteFrame`
- source 必须有 texture
- source 必须有 render material
- source assembler 必须实现 `fillSharedBuffers`

校验通过后：

```text
sourceAssembler.fillSharedBuffers(sourceSprite, copySprite, this)
```

### 6.3 `commitSharedComp()`

`commitSharedComp()` 负责提交 copy 的 renderData，但批次状态参考 source 的材质/纹理：

- `renderData` 使用 copy 的 `renderData`
- `frame` 使用 source 的 `spriteFrame`
- `material` 使用 source 的 material
- `layer` 使用 copy node layer
- `stencilStage` 使用 copy 当前 stencil stage
- `fillBuffers()` 使用 copySprite

这保证了：

```text
共享 source 的贴图/材质
保留 copy 的空间位置/层级/颜色/透明度
```

## 7. Node 生命周期改动

文件：`cocos/core/scene-graph/node.ts`

新增字段：

```text
copyChidrens: Node[] | null
_sharedRenderSource: Node | null
isShareNode
```

新增方法：

```text
addCopyChildren(node: Node)
removeCopyChildren(node: Node)
```

设计目的：

- source 记录所有 copy。
- copy 记录自己的 source。
- copy 重新绑定到其它 source 时，会先从旧 source 移除。
- source/copy 销毁时，会清理互相引用，降低状态残留风险。

注意：字段名当前为 `copyChidrens`，这是已有实现中的拼写。后续如果要改名，需要同步修改所有引用和旧数据兼容策略。

## 8. 性能边界

当前共享方案可以减少：

- 每个 copy 重复计算 SIMPLE 局部顶点。
- 每个 copy 重复更新 UV。
- 每个 copy 重复根据自身 SpriteFrame 做动态图集/材质/纹理状态更新。
- 静态 copy 每帧强制 `vertDirty` 的额外开销。
- 静态 shared copy 每帧强制 `updateOpacity()` 的额外开销。

当前共享方案不能减少：

- 节点树遍历。
- 每个 copy 的组件存在成本。
- 每个 copy 的 `renderData/chunk`。
- 每个 copy 的最终顶点写入。
- 每个 copy transform 变化时的 world vertex 计算。

如果目标是大量相同 Sprite 的数量级性能提升，需要继续考虑：

- 合并多个 copy 到一个共享大 renderData。
- 或做 GPU Instancing。
- 或在业务层减少 Node/Sprite 数量。

## 9. 已知风险与后续检查项

### 9.1 batch 合并

`RenderData.updateHash()` 当前包含 `chunk.bufferId`。copy 拥有独立 chunk 时，如果不同 copy 的 `bufferId` 不同，可能导致 batch hash 不一致，从而增加 batch/Renderer。

后续需要重点验证：

- 同 texture、同 material、同 layer 的 shared copy 是否能合批。
- `Renderer(ms)` 是否下降。
- `drawCalls` 是否变化。
- `batches` 是否异常上升。

### 9.2 动态图集

source 的 `updateRenderData()` 会走：

```text
dynamicAtlasManager.packToDynamicAtlas(sourceSprite, frame)
```

copy 不再独立 pack。需要验证：

- source 首次进入动态图集后，copy UV 是否正确。
- source 换图后，copy texture/UV 是否刷新。
- 动态图集重排或 atlas frame 更新时，copy 是否跟随。

### 9.3 换材质 / 灰度 / alpha 分离

当前 copy 使用 source material/texture。需要逐项验证：

- source 换 customMaterial。
- source 开启/关闭灰度。
- source 使用 alpha separated texture。
- source spriteFrame 换成不同 texture。
- copy 自己设置 customMaterial 时是否应该被禁止或忽略。

### 9.4 opacity 级联

当前 `Batcher2D.walk()` 仍然使用原版 `_pOpacity` 级联逻辑。shared copy 只有在以下情况更新 opacity：

- 父级链路出现 color dirty。
- copy 首次同步 color。
- copy color 变化。

需要验证：

- 父节点透明度变化。
- copy 自身 alpha 变化。
- source alpha 变化。
- copy 挪到不同透明度父节点下。

### 9.5 生命周期

已经补充 remove/destroy 清理，但仍建议验证：

- source destroy 后 copy 是否停止共享渲染。
- copy destroy 后 source 列表是否移除。
- copy 重新绑定到另一个 source 是否正确去重。
- source/copy disable/enable 后状态是否恢复。

## 10. 测试方法

项目脚本：

```text
D:/CocosProject/evil-spiritTiledMap/assets/ShareNode/SpriteTest.ts
```

Inspector 参数：

```text
copyCount = 100
columns = 10
spacingX = 70
spacingY = 70
warmupFrames = 60
sampleFrames = 180
autoStartCompare = true
clearAfterTest = false
```

测试流程：

```text
normal 模式创建普通 Sprite copy
    -> warmupFrames
    -> sampleFrames 采样
    -> 输出 normal result
    -> 清理节点

shared 模式创建共享 Copy 节点
    -> warmupFrames
    -> sampleFrames 采样
    -> 输出 shared result
    -> 输出 shared - normal 差值
```

统计指标：

- `frameAvg`
- `frameMax`
- `rendererAvg`
- `rendererMax`
- `drawCallsAvg`
- `batchesAvg`
- `instancesAvg`

输出位置：

```text
浏览器/预览控制台
Cocos Creator Console
```

## 11. 当前实现结论

当前 `Sprite.Type.SIMPLE` 共享渲染功能已经具备主流程：

```text
source/copy 绑定
Batcher2D 识别 shared copy
source assembler 执行 fillSharedBuffers
copy 保留自己的 renderData/chunk/worldMatrix/color/opacity
source 提供 frame/texture/material/local vertex/UV
```

性能上，已经修复了早期 shared copy 每帧强制刷新共享数据的问题。但这仍不是最终高性能方案，因为每个 copy 仍然是一个 Node + Sprite + renderData/chunk。后续优化重点应放在 batch hash、批次合并，以及是否要进一步做合并渲染或 GPU Instancing。
