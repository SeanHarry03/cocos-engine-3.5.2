/*
 Copyright (c) 2017-2020 Xiamen Yaji Software Co., Ltd.

 https://www.cocos.com/

 Permission is hereby granted, free of charge, to any person obtaining a copy
 of this software and associated engine source code (the "Software"), a limited,
 worldwide, royalty-free, non-assignable, revocable and non-exclusive license
 to use Cocos Creator solely to develop games on your target platforms. You shall
 not use Cocos Creator software for developing other software or tools that's
 used for developing games. You are not granted to publish, distribute,
 sublicense, and/or sell copies of Cocos Creator.

 The software or tools in this License Agreement are licensed, not sold.
 Xiamen Yaji Software Co., Ltd. reserves all rights not expressly granted to you.

 THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 THE SOFTWARE.
*/

import { Vec3 } from '../../../core/math';
import { Material } from '../../../core/assets/material';
import { IAssembler } from '../../renderer/base';
import { IRenderData, RenderData } from '../../renderer/render-data';
import { IBatcher } from '../../renderer/i-batcher';
import { Sprite } from '../../components';
import { SpriteFrame } from '../../assets/sprite-frame';
import { dynamicAtlasManager } from '../../utils/dynamic-atlas/atlas-manager';
import { StaticVBChunk } from '../../renderer/static-vb-accessor';

const vec3_temps: Vec3[] = [];
for (let i = 0; i < 4; i++) {
    vec3_temps.push(new Vec3());
}

interface ISharedSimpleSourceState {
    sourceSprite: Sprite;
    preparedFrame: number;
    initialized: boolean;
    rectVersion: number;
    uvVersion: number;
    batchVersion: number;
    l: number;
    b: number;
    r: number;
    t: number;
    uv0: number;
    uv1: number;
    uv2: number;
    uv3: number;
    uv4: number;
    uv5: number;
    uv6: number;
    uv7: number;
    frame: SpriteFrame;
    material: Material | null;
    blendHash: number;
    textureHash: number;
}

interface ISharedSimpleCopyState {
    sourceSprite: Sprite;
    chunk: StaticVBChunk;
    rectVersion: number;
    uvVersion: number;
    batchVersion: number;
    colorR: number;
    colorG: number;
    colorB: number;
    colorA: number;
}

// RenderData is pooled. WeakMaps keep shared-only metadata out of the pooled objects
// and the sprite/chunk guards below protect against a recycled RenderData entry.
const sharedSourceStates = new WeakMap<RenderData, ISharedSimpleSourceState>();
const sharedCopyStates = new WeakMap<RenderData, ISharedSimpleCopyState>();

/**
 * simple 组装器
 * 可通过 `UI.simple` 获取该组装器。
 */
export const simple: IAssembler = {
    createData(sprite: Sprite) {
        const renderData = sprite.requestRenderData();
        renderData.dataLength = 2;
        renderData.resize(4, 6);
        return renderData;
    },

    updateRenderData(sprite: Sprite) {
        const frame = sprite.spriteFrame;

        // TODO: Material API design and export from editor could affect the material activation process
        // need to update the logic here
        // if (frame) {
        //     if (!frame._original && dynamicAtlasManager) {
        //         dynamicAtlasManager.insertSpriteFrame(frame);
        //     }
        //     if (sprite._material._texture !== frame._texture) {
        //         sprite._activateMaterial();
        //     }
        // }
        dynamicAtlasManager.packToDynamicAtlas(sprite, frame);
        this.updateUVs(sprite);

        const renderData = sprite.renderData;
        if (renderData && frame) {
            if (renderData.vertDirty) {
                this.updateVertexData(sprite);
            }
            renderData.updateRenderData(sprite, frame);
        }
    },

    updateWorldVerts(sprite: Sprite, chunk: StaticVBChunk) {
        const renderData = sprite.renderData!;
        const vData = chunk.vb;

        const dataList: IRenderData[] = renderData.data;
        const node = sprite.node;

        const data0 = dataList[0];
        const data3 = dataList[1];
        const matrix = node.worldMatrix;
        const a = matrix.m00; const b = matrix.m01;
        const c = matrix.m04; const d = matrix.m05;

        const justTranslate = a === 1 && b === 0 && c === 0 && d === 1;

        const tx = matrix.m12; const ty = matrix.m13;
        const vl = data0.x; const vr = data3.x;
        const vb = data0.y; const vt = data3.y;

        if (justTranslate) {
            const vltx = vl + tx;
            const vrtx = vr + tx;
            const vbty = vb + ty;
            const vtty = vt + ty;

            // left bottom
            vData[0] = vltx;
            vData[1] = vbty;
            // right bottom
            vData[9] = vrtx;
            vData[10] = vbty;
            // left top
            vData[18] = vltx;
            vData[19] = vtty;
            // right top
            vData[27] = vrtx;
            vData[28] = vtty;
        } else {
            const al = a * vl; const ar = a * vr;
            const bl = b * vl; const br = b * vr;
            const cb = c * vb; const ct = c * vt;
            const db = d * vb; const dt = d * vt;

            const cbtx = cb + tx;
            const cttx = ct + tx;
            const dbty = db + ty;
            const dtty = dt + ty;

            // left bottom
            vData[0] = al + cbtx;
            vData[1] = bl + dbty;
            // right bottom
            vData[9] = ar + cbtx;
            vData[10] = br + dbty;
            // left top
            vData[18] = al + cttx;
            vData[19] = bl + dtty;
            // right top
            vData[27] = ar + cttx;
            vData[28] = br + dtty;
        }
    },

    fillBuffers(sprite: Sprite, renderer: IBatcher) {
        if (sprite === null) {
            return;
        }
        const renderData = sprite.renderData!;
        const chunk = renderData.chunk;
        if (sprite.node.hasChangedFlags || renderData.vertDirty) {
            // const vb = chunk.vertexAccessor.getVertexBuffer(chunk.bufferId);
            this.updateWorldVerts(sprite, chunk);
            renderData.vertDirty = false;
        }

        // quick version
        const bid = chunk.bufferId;
        const vid = chunk.vertexOffset;
        const meshBuffer = chunk.vertexAccessor.getMeshBuffer(bid);
        const ib = chunk.vertexAccessor.getIndexBuffer(bid);
        let indexOffset = meshBuffer.indexOffset;
        ib[indexOffset++] = vid;
        ib[indexOffset++] = vid + 1;
        ib[indexOffset++] = vid + 2;
        ib[indexOffset++] = vid + 2;
        ib[indexOffset++] = vid + 1;
        ib[indexOffset++] = vid + 3;
        meshBuffer.indexOffset += 6;

        // slow version
        // renderer.switchBufferAccessor().appendIndices(chunk);
    },

    updateVertexData(sprite: Sprite) {
        const renderData: RenderData | null = sprite.renderData;
        if (!renderData) {
            return;
        }

        const uiTrans = sprite.node._uiProps.uiTransformComp!;
        const dataList: IRenderData[] = renderData.data;
        const cw = uiTrans.width;
        const ch = uiTrans.height;
        const appX = uiTrans.anchorX * cw;
        const appY = uiTrans.anchorY * ch;
        let l = 0;
        let b = 0;
        let r = 0;
        let t = 0;
        if (sprite.trim) {
            l = -appX;
            b = -appY;
            r = cw - appX;
            t = ch - appY;
        } else {
            const frame = sprite.spriteFrame!;
            const originSize = frame.getOriginalSize();
            const rect = frame.getRect();
            const ow = originSize.width;
            const oh = originSize.height;
            const rw = rect.width;
            const rh = rect.height;
            const offset = frame.getOffset();
            const scaleX = cw / ow;
            const scaleY = ch / oh;
            const trimLeft = offset.x + (ow - rw) / 2;
            const trimRight = offset.x - (ow - rw) / 2;
            const trimBottom = offset.y + (oh - rh) / 2;
            const trimTop = offset.y - (oh - rh) / 2;
            l = trimLeft * scaleX - appX;
            b = trimBottom * scaleY - appY;
            r = cw + trimRight * scaleX - appX;
            t = ch + trimTop * scaleY - appY;
        }

        dataList[0].x = l;
        dataList[0].y = b;

        dataList[1].x = r;
        dataList[1].y = t;

        renderData.vertDirty = true;
    },

    updateUVs(sprite: Sprite) {
        if (!sprite.spriteFrame) return;
        const renderData = sprite.renderData!;
        const vData = renderData.chunk.vb;
        const uv = sprite.spriteFrame.uv;
        vData[3] = uv[0];
        vData[4] = uv[1];
        vData[12] = uv[2];
        vData[13] = uv[3];
        vData[21] = uv[4];
        vData[22] = uv[5];
        vData[30] = uv[6];
        vData[31] = uv[7];
    },

    updateColor(sprite: Sprite) {
        const renderData = sprite.renderData!;
        const vData = renderData.chunk.vb;
        let colorOffset = 5;
        const color = sprite.color;
        const colorR = color.r / 255;
        const colorG = color.g / 255;
        const colorB = color.b / 255;
        const colorA = color.a / 255;
        for (let i = 0; i < 4; i++, colorOffset += renderData.floatStride) {
            vData[colorOffset] = colorR;
            vData[colorOffset + 1] = colorG;
            vData[colorOffset + 2] = colorB;
            vData[colorOffset + 3] = colorA;
        }
    },

    fillSharedBuffers (sourceSprite: Sprite, copySprite: Sprite, renderer: IBatcher) {
        const frame = sourceSprite.spriteFrame;
        if (!frame) {
            return;
        }

        let sourceRenderData = sourceSprite.renderData!;
        if (!sourceRenderData) {
            sourceRenderData = this.createData(sourceSprite);
        }

        let copyRenderData = copySprite.renderData!;
        if (!copyRenderData) {
            copyRenderData = this.createData(copySprite);
        }

        let sourceState = sharedSourceStates.get(sourceRenderData);
        if (!sourceState || sourceState.sourceSprite !== sourceSprite) {
            sourceState = {
                sourceSprite,
                preparedFrame: -1,
                initialized: false,
                rectVersion: 0,
                uvVersion: 0,
                batchVersion: 0,
                l: 0,
                b: 0,
                r: 0,
                t: 0,
                uv0: 0,
                uv1: 0,
                uv2: 0,
                uv3: 0,
                uv4: 0,
                uv5: 0,
                uv6: 0,
                uv7: 0,
                frame,
                material: null,
                blendHash: -1,
                textureHash: 0,
            };
            sharedSourceStates.set(sourceRenderData, sourceState);
        }

        // All copies of a source observe the same source state. Prepare and compare
        // that state only for the first copy encountered during this UI frame.
        if (sourceState.preparedFrame !== renderer.sharedFrameId) {
            if (sourceRenderData.vertDirty || sourceRenderData.passDirty || sourceRenderData.textureDirty
                || sourceRenderData.nodeDirty || sourceRenderData.hashDirty) {
                this.updateRenderData(sourceSprite);
            }

            const sourceData = sourceRenderData.data;
            const l = sourceData[0].x;
            const b = sourceData[0].y;
            const r = sourceData[1].x;
            const t = sourceData[1].y;
            if (!sourceState.initialized || sourceState.l !== l || sourceState.b !== b
                || sourceState.r !== r || sourceState.t !== t) {
                sourceState.l = l;
                sourceState.b = b;
                sourceState.r = r;
                sourceState.t = t;
                ++sourceState.rectVersion;
            }

            const uv = frame.uv;
            if (!sourceState.initialized
                || sourceState.uv0 !== uv[0] || sourceState.uv1 !== uv[1]
                || sourceState.uv2 !== uv[2] || sourceState.uv3 !== uv[3]
                || sourceState.uv4 !== uv[4] || sourceState.uv5 !== uv[5]
                || sourceState.uv6 !== uv[6] || sourceState.uv7 !== uv[7]) {
                sourceState.uv0 = uv[0];
                sourceState.uv1 = uv[1];
                sourceState.uv2 = uv[2];
                sourceState.uv3 = uv[3];
                sourceState.uv4 = uv[4];
                sourceState.uv5 = uv[5];
                sourceState.uv6 = uv[6];
                sourceState.uv7 = uv[7];
                ++sourceState.uvVersion;
            }

            const material = sourceSprite.getRenderMaterial(0);
            const textureHash = frame.getHash();
            if (!sourceState.initialized || sourceState.frame !== frame || sourceState.material !== material
                || sourceState.blendHash !== sourceSprite.blendHash || sourceState.textureHash !== textureHash) {
                sourceState.frame = frame;
                sourceState.material = material;
                sourceState.blendHash = sourceSprite.blendHash;
                sourceState.textureHash = textureHash;
                ++sourceState.batchVersion;
            }

            sourceState.initialized = true;
            sourceState.preparedFrame = renderer.sharedFrameId;
        }

        let copyState = sharedCopyStates.get(copyRenderData);
        if (!copyState || copyState.sourceSprite !== sourceSprite || copyState.chunk !== copyRenderData.chunk) {
            copyState = {
                sourceSprite,
                chunk: copyRenderData.chunk,
                rectVersion: -1,
                uvVersion: -1,
                batchVersion: -1,
                colorR: -1,
                colorG: -1,
                colorB: -1,
                colorA: -1,
            };
            sharedCopyStates.set(copyRenderData, copyState);
        }

        if (copyState.rectVersion !== sourceState.rectVersion) {
            const copyData = copyRenderData.data;
            copyData[0].x = sourceState.l;
            copyData[0].y = sourceState.b;
            copyData[1].x = sourceState.r;
            copyData[1].y = sourceState.t;
            copyRenderData.vertDirty = true;
            copyState.rectVersion = sourceState.rectVersion;
        }

        if (copyState.uvVersion !== sourceState.uvVersion) {
            const vData = copyRenderData.chunk.vb;
            vData[3] = sourceState.uv0;
            vData[4] = sourceState.uv1;
            vData[12] = sourceState.uv2;
            vData[13] = sourceState.uv3;
            vData[21] = sourceState.uv4;
            vData[22] = sourceState.uv5;
            vData[30] = sourceState.uv6;
            vData[31] = sourceState.uv7;
            copyState.uvVersion = sourceState.uvVersion;
        }

        if (copyState.batchVersion !== sourceState.batchVersion || copyRenderData.passDirty) {
            copyRenderData.updatePass(sourceSprite);
        }
        if (copyState.batchVersion !== sourceState.batchVersion || copyRenderData.textureDirty) {
            copyRenderData.updateTexture(sourceState.frame);
        }
        copyState.batchVersion = sourceState.batchVersion;

        if (copyRenderData.nodeDirty || copyRenderData.layer !== copySprite.node.layer) {
            copyRenderData.updateNode(copySprite);
        }
        if (copyRenderData.hashDirty) {
            copyRenderData.updateHash();
        }

        const color = copySprite.color;
        if (copyState.colorR !== color.r || copyState.colorG !== color.g
            || copyState.colorB !== color.b || copyState.colorA !== color.a) {
            this.updateColor(copySprite);
            (copyRenderData as any)._sharedOpacityDirty = true;
            copyState.colorR = color.r;
            copyState.colorG = color.g;
            copyState.colorB = color.b;
            copyState.colorA = color.a;
        }

        renderer.commitSharedComp(sourceSprite, copySprite, copyRenderData, sourceState.frame, this, null);

        /**
         *  共享:
            图片形状
            UV
            纹理
            材质

            不共享:
            copy 的 color
            copy 的 alpha
            copy 的 worldMatrix
         */
    },
};
