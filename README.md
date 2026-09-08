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
  - 增加 `sharedFrameId`，为共享数据提供低成本的 UI 帧标识。

- `cocos/2d/renderer/i-batcher.ts`
  - 给 `IBatcher` 增加 `commitSharedComp()` 接口声明。
  - 给 `IBatcher` 增加只读 `sharedFrameId` 接口声明。

- `cocos/2d/framework/renderable-2d.ts`
  - 暴露 `assembler` getter，允许 `Batcher2D.walkShare()` 取得 source Sprite 当前 assembler。

- `cocos/2d/assembler/sprite/simple.ts`
  - 增加 `fillSharedBuffers()`。
  - 将 source 的 SIMPLE 局部顶点、UV、材质、纹理状态同步给 copy。
  - copy 使用自己的 `renderData/chunk/color/opacity/worldMatrix`。
  - 增加 source/copy 版本缓存，source 每帧只准备一次，copy 按版本同步变化的数据。

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

当前实现为 source 维护 `rectVersion`：同一个 source 每帧只比较一次局部顶点。版本变化后，各 copy 才复制局部顶点并把 `copyRenderData.vertDirty = true`。静态节点不会再逐 copy 比较四个顶点值，也不会每帧强制 dirty。

### 5.4 UV 同步

共享路径读取 source 的 `frame.uv`，写入 copy chunk 的 UV 槽位：

```text
vData[3],  vData[4]
vData[12], vData[13]
vData[21], vData[22]
vData[30], vData[31]
```

这对应原版 `simple.updateUVs(sprite)` 的结果。

当前实现通过 source 的 `uvVersion` 缓存 UV。同一个 source 每帧只比较一次八个 UV 值，只有版本变化时 copy 才写入自己的 chunk。

### 5.5 material / texture / layer / hash 同步

共享路径使用 source 的材质和纹理，但使用 copy 的 layer：

```text
copyRenderData.updatePass(sourceSprite)
copyRenderData.updateTexture(sourceFrame)
copyRenderData.updateNode(copySprite)
copyRenderData.updateHash()
```

当前实现通过 source 的 `batchVersion` 缓存 material、frame、blendHash 和 texture hash。同一个 source 每帧只读取和比较一次这些状态，copy 只有版本变化或自身 dirty 时才更新：

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

`RenderData.updateHash()` 包含 `chunk.bufferId`。独立 chunk 通常仍可位于同一个 MeshBuffer，因此不会天然阻止合批；只有 chunk 分配到不同 `bufferId` 时才必须拆批，因为不同 buffer 对应不同的 GPU Buffer/InputAssembler，不能通过删除 `bufferId` 强行合并。

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

性能上，已经修复了早期 shared copy 每帧强制刷新共享数据的问题，并把 source 的局部顶点、UV、材质和纹理状态检查从“每帧每 copy 一次”降低为“每帧每 source 一次”。copy 热路径只比较 source 的三个版本号，并继续保留自己的 Node、Sprite、renderData/chunk、worldMatrix、color 和 opacity。

当前未实现 GPU Instancing。下一阶段如果仍需提高大量静态 shared copy 的性能，应优先测量节点遍历、每 copy 提交、索引重写和 MeshBuffer 上传成本，再决定是否增加共享大 renderData/SharedSpriteGroup。

## 12. 本次版本缓存优化技术详解

本节记录“为什么要改、怎样改、如何保证正确”，用于后续重新阅读代码时快速恢复上下文。

### 12.1 优化前的问题

旧版已经避免了数据未变化时真正写入 copy chunk，但每个 copy 每帧仍需要逐项确认 source 是否变化：

```text
4 个局部顶点边界值
8 个 UV 值
material 引用
blendHash
SpriteFrame 引用
textureHash
```

假设一个 source 有 `N` 个 copy，source 数据检查的复杂度仍然是：

```text
O(N × sourceStateFieldCount)
```

数据不变时虽然没有内存写入，但 JavaScript 仍然需要执行大量属性访问、函数调用和条件分支。copy 数量越多，这部分固定 CPU 成本越明显。

本次优化应用了两个通用原则：

1. 循环不变量外提：同一帧内，所有 copy 看到的 source 状态相同，只需要准备一次。
2. 版本号传播：copy 不需要重新判断 source 的每个字段，只需要判断自己是否应用过最新版本。

### 12.2 总体数据流

优化后的数据流如下：

```text
Batcher2D.reset()
    -> sharedFrameId++

本帧第一个 shared copy
    -> 发现 sourceState.preparedFrame != sharedFrameId
    -> 必要时 updateRenderData(source)
    -> 比较 source 局部顶点，变化则 rectVersion++
    -> 比较 source UV，变化则 uvVersion++
    -> 比较 source 批次状态，变化则 batchVersion++
    -> preparedFrame = sharedFrameId

本帧后续 shared copy
    -> source 已准备，不再重复读取和比较 source 全部字段
    -> 比较 copy 已应用的三个版本号
    -> 只同步版本发生变化的数据
    -> 提交 copy
```

注意：`sharedFrameId` 在一帧渲染结束后的 `Batcher2D.reset()` 中递增。下一帧第一次遇到 source 时，`preparedFrame` 与新帧号不同，因此会重新检查一次 source。

### 12.3 source 状态结构

source 缓存类型为 `ISharedSimpleSourceState`，主要分成四类信息：

```text
身份与帧状态
    sourceSprite
    preparedFrame
    initialized

版本号
    rectVersion
    uvVersion
    batchVersion

SIMPLE 静态几何
    l / b / r / t
    uv0 ... uv7

批次状态
    frame
    material
    blendHash
    textureHash
```

版本号分成三个，而不是只使用一个总版本号，原因是不同变化触发的工作不同：

| 版本 | source 变化 | copy 需要执行的操作 |
|---|---|---|
| `rectVersion` | 宽高、锚点、trim 或局部矩形变化 | 复制 `l/b/r/t`，设置 `vertDirty`，重新计算世界顶点 |
| `uvVersion` | SpriteFrame UV、动态图集位置变化 | 重写 copy chunk 的 8 个 UV |
| `batchVersion` | frame、material、blendHash、textureHash 变化 | 更新 pass、texture 和 batch hash |

如果只使用一个总版本号，source 仅换材质时也会让所有 copy 重写 UV、局部顶点并重新计算世界顶点。拆分版本可以避免这种无关刷新。

### 12.4 copy 状态结构

copy 缓存类型为 `ISharedSimpleCopyState`：

```text
sourceSprite
chunk
rectVersion
uvVersion
batchVersion
colorR / colorG / colorB / colorA
```

前三个版本表示“该 copy 最后应用到哪个 source 版本”，并不是 copy 自己的数据版本。

首次创建 copy 状态时，三个版本初始化为 `-1`。source 的版本从 `0` 开始，并在首次准备时递增，所以新 copy 一定会完整同步一次。

`sourceSprite` 和 `chunk` 是缓存安全校验：

- copy 改绑其它 source 时，旧版本不能继续使用。
- RenderData resize 或重新分配 chunk 后，UV 必须写入新 chunk。
- RenderData 来自对象池，不能假设同一个 RenderData 对象永远属于同一个 Sprite。

### 12.5 为什么使用 WeakMap

source 和 copy 状态分别保存在：

```ts
WeakMap<RenderData, ISharedSimpleSourceState>
WeakMap<RenderData, ISharedSimpleCopyState>
```

没有继续把 `_sharedSimpleState` 动态挂到 RenderData 上，原因是：

- `RenderData` 会被对象池回收和复用，动态字段容易携带上一个使用者的状态。
- WeakMap 不修改引擎 RenderData 的公开结构。
- RenderData 不再被其它对象强引用后，WeakMap 项可以随 GC 自动释放。
- 配合 `sourceSprite/chunk` 校验，可以安全识别对象池复用和 chunk 更换。

WeakMap 解决的是共享元数据的生命周期问题；它不会替代 Node 销毁时对 source/copy 双向关系的显式清理。

### 12.6 source 每帧准备一次

核心判断是：

```ts
if (sourceState.preparedFrame !== renderer.sharedFrameId) {
    // 本帧只进入一次
}
```

进入准备阶段后，仍然先检查原版 RenderData dirty 标记：

```text
vertDirty
passDirty
textureDirty
nodeDirty
hashDirty
```

只要任意 dirty，就调用原版 `updateRenderData(sourceSprite)`。这样仍能保留：

- 动态图集打包。
- source 局部顶点更新。
- source UV 更新。
- material、texture、layer 和 hash 更新。

然后读取 source 最新结果，与 sourceState 中的上一帧值比较，并分别更新三个版本号。

### 12.7 copy 按版本同步

copy 的主要热路径变为：

```text
rectVersion 是否不同？
    是 -> 复制局部矩形，vertDirty = true

uvVersion 是否不同？
    是 -> 写入 8 个 UV

batchVersion 是否不同？
    是 -> updatePass + updateTexture

copy layer 是否变化？
    是 -> updateNode

hashDirty？
    是 -> updateHash

copy color 是否变化？
    是 -> updateColor，并请求 opacity 更新
```

layer、color、opacity 和 worldMatrix 属于 copy，自身仍需独立检查，不能放到 source 版本中。

### 12.8 优化前后复杂度

设一个 source 有 `N` 个 copy，source 静态字段数量记为 `F`。

| 工作 | 优化前 | 优化后 |
|---|---:|---:|
| source dirty 检查 | `O(N)` | `O(1)`/source/frame |
| source 局部顶点与 UV 比较 | `O(N × F)` | `O(F)`/source/frame |
| source material 与 texture getter/hash | `O(N)` | `O(1)`/source/frame |
| copy 共享状态判断 | 多个字段逐项比较 | 3 个整数版本比较/copy |
| copy worldMatrix、layer、color | `O(N)` | `O(N)`，保持不变 |
| copy index 写入与提交 | `O(N)` | `O(N)`，保持不变 |

因此这次优化降低的是共享静态状态管理成本，没有消除 Node 遍历、copy transform、index 写入和 MeshBuffer 上传。

### 12.9 数据变化时的传播结果

| 操作 | 变化的版本/状态 | 结果 |
|---|---|---|
| source UITransform 宽高或锚点变化 | `rectVersion` | 所有 copy 下一次访问时重算世界顶点 |
| source SpriteFrame UV 变化 | `uvVersion` | 所有 copy 更新 UV |
| source 更换 SpriteFrame | 通常 `uvVersion + batchVersion`，必要时还有 `rectVersion` | 更新 UV、纹理、hash 和必要的几何 |
| source 更换材质或灰度状态 | `batchVersion` | copy 更新 pass 和 batch hash |
| source texture hash 变化 | `batchVersion` | copy 更新 texture 和 batch hash |
| copy 移动、旋转或缩放 | Node change flag | 只重算该 copy 世界顶点 |
| copy layer 变化 | copy `nodeDirty/layer` | 只更新该 copy node/hash，可能断批 |
| copy color 变化 | copy color cache | 只更新该 copy 顶点颜色和 opacity |
| copy 改绑 source | `sourceSprite` 校验失败 | 重建 copyState，并完整同步新 source |
| copy chunk 被重新分配 | `chunk` 校验失败 | 重建 copyState，并向新 chunk 完整写入 |

### 12.10 batch hash 与版本缓存的关系

版本号只决定“copy 是否需要刷新 RenderData”，不直接代替最终 batch hash。

最终是否能够合批，仍由以下条件决定：

```text
bufferId
layer
blendHash
textureHash
material
stencil stage
渲染顺序是否连续
```

`batchVersion` 变化后会使 copy 执行 `updatePass()` / `updateTexture()`，这些方法设置 `hashDirty`，随后 `updateHash()` 生成真正参与 Batcher2D 比较的 `dataHash`。

因此：

- version 是 CPU 侧的增量同步机制。
- dataHash 是 draw batch 的兼容性判断。
- 两者用途不同，不能互相替换。

### 12.11 当前仍存在的主要成本

完成版本缓存后，如果 copy 数量继续增加，热点预计会逐渐转移到：

1. `Batcher2D.walk()` 的 Node 树遍历与组件判断。
2. 每个 copy 的 `commitSharedComp()` 调用和批次条件比较。
3. 每个可见 copy 每帧写入 6 个 index。
4. copy transform 变化时的 `updateWorldVerts()`。
5. MeshBuffer 标脏后的 VertexBuffer/IndexBuffer 上传。
6. 大量 Node、Sprite、RenderData 和 chunk 的常驻内存。

这也是后续优化必须继续 profiler-first 的原因：版本缓存完成后，不能根据旧热点继续猜测下一步。

### 12.12 推荐的性能验证矩阵

不要只测试 `copyCount = 100`。建议固定设备、分辨率和构建模式，分别测量：

| copy 数量 | 全部静止 | 10% 每帧移动 | 100% 每帧移动 |
|---:|---:|---:|---:|
| 100 | 基线 | 轻度动态 | 动态上限参考 |
| 1,000 | 中量基线 | 常见压力 | transform 压力 |
| 10,000 | 大量静态压力 | 混合压力 | 极限压力 |

每组至少包含：

```text
warmup 60 帧以上
采样 180～600 帧
normal 与 shared 使用相同节点顺序
记录平均值、最大值，并观察 P95/P99（测试脚本支持后再加入）
```

重点指标及解释：

| 指标 | 用途 |
|---|---|
| `Renderer(ms)` | 版本缓存最应该直接改善的指标 |
| `frameTime` | 判断优化是否能反映到总帧时间 |
| `drawCalls/batches` | 确认没有因 hash 或状态同步产生额外断批 |
| `instances` | 确认实际提交数量一致，避免少画造成假优化 |
| GC/heap allocation | 确认热路径没有产生新的临时对象 |

### 12.13 阅读代码时应记住的设计不变量

后续维护这套功能时，需要始终保持以下约束：

1. source 只提供静态渲染描述，不能提供 copy 的最终世界顶点。
2. copy 不能共享 source 的 chunk，否则位置、颜色和 opacity 会互相覆盖。
3. source 状态同一 UI 帧只准备一次，但下一帧仍必须允许重新检查。
4. 新 copy、换 source、换 chunk 必须完整同步，不能只看版本号数值巧合。
5. source 的 rect、UV、batch 状态必须使用独立版本，避免无关数据刷新。
6. copy 的 layer、color、opacity、worldMatrix 必须保持独立。
7. `bufferId` 是物理 MeshBuffer 边界，不能为了减少 batch 数量从 hash 中直接删除。
8. 优化后 draw call 不一定下降；本次主要目标是降低 Renderer CPU 时间。

### 12.14 后续非 Instancing 优化路线

当前明确不实现 GPU Instancing。后续仍可按性价比依次考虑：

1. 给 `walkShare()` 缓存已验证的 source/copy 关系，减少每帧 `instanceof`、assembler 和 material getter。
2. 给 `commitSharedComp()` 增加 shared fast path，减少与普通组件重复的状态读取。
3. 统计 batch break 原因，确认真正的断批来源后再调整 batch key。
4. 对连续同 source copy 建立 `SharedSpriteGroup`，批量提交 index 和状态。
5. 对长期静止的 group 使用独立静态缓冲，只在成员变化时上传。
6. 如果 Node 遍历成为主热点，在业务层使用轻量实例数据代替一部分 Node/Sprite。

每一步都应先记录优化前 profile，再实施单一改动并做 A/B 对照，避免 draw call、Mask、透明度或动态图集正确性回退。
