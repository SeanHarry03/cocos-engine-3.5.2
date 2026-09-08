# Sprite 相关知识点

## 1.chunk.bufferId

这个 Sprite 的顶点数据位于 StaticVBAccessor 管理的第几个 MeshBuffer 中。

StaticVBAccessor
├── MeshBuffer[0]  ← bufferId = 0
│   ├── chunk A
│   ├── chunk B
│   └── chunk C
├── MeshBuffer[1]  ← bufferId = 1
│   ├── chunk D
│   └── chunk E
└── ...

定义在 [static-vb-accessor.ts (line 47)](./cocos/2d/renderer/static-vb-accessor.ts:47)：
export class StaticVBChunk {
    constructor (
        public vertexAccessor: StaticVBAccessor,
        public bufferId: number,
        public vertexOffset: number,
        public vb: Float32Array,
        indexCount: number,
    ) {}
}


几个概念的区别：
- StaticVBAccessor：管理一组相同顶点格式的 MeshBuffer。
- MeshBuffer：一块实际用于批量上传到 GPU 的顶点和索引缓冲。
- StaticVBChunk：从某个 MeshBuffer 中划分出来的一小段空间。
- bufferId：这个 chunk 属于 _buffers 数组中的哪一个 MeshBuffer。
- vertexOffset：这个 chunk 在该 MeshBuffer 中从第几个顶点开始。

例如：
copyA.chunk.bufferId     = 0
copyA.chunk.vertexOffset = 0

copyB.chunk.bufferId     = 0
copyB.chunk.vertexOffset = 4

copyC.chunk.bufferId     = 1
copyC.chunk.vertexOffset = 0
A 和 B 位于同一个 MeshBuffer，只是占用不同区域；C 位于另一个 MeshBuffer。
为什么会出现多个 bufferId
每个 MeshBuffer 容量有限。分配 chunk 时会依次查找有足够空间的 MeshBuffer：
[static-vb-accessor.ts (line 140)](./cocos/2d/renderer/static-vb-accessor.ts:140)
如果已有 buffer 放不下，就创建新的 buffer：
if (!entry) {
    bid = this._allocateBuffer();
}
默认 2D buffer 增量是 144KB。SIMPLE Sprite 每个顶点约 36 bytes、每个 Sprite 4 个顶点，因此一个 buffer 理论上大约容纳：
144 × 1024 / 36 / 4 ≈ 1024 个 Sprite
实际数量还会受其它 UI 渲染数据、回收碎片和顶点格式影响。
为什么 batch hash 包含 bufferId
[render-data.ts (line 244)](./cocos/2d/renderer/render-data.ts:244)：
const bid = this.chunk ? this.chunk.bufferId : -1;
const hashString =
    `${bid}${this.layer} ${this.blendHash} ${this.textureHash}`;
因为一个 draw batch 使用一个 InputAssembler，而 InputAssembler 绑定具体的 VertexBuffer 和 IndexBuffer。
即使两个 Sprite：
texture 相同
material 相同
layer 相同
blend 相同
如果它们分别位于 MeshBuffer[0] 和 MeshBuffer[1]，也不能直接组成同一个 draw call：
bufferId 相同     → 有机会合批
bufferId 不同     → 必须拆批
所以不能简单从 hash 中删除 bufferId。
需要特别注意：bufferId 不是全局 GPU Buffer ID，只是当前 StaticVBAccessor._buffers 数组中的下标。不同顶点格式对应不同的 accessor，各自都可能存在 bufferId = 0。