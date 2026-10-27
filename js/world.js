/**
 * world.js
 * ------------------------------------------------------------
 * 복셀 월드 데이터와 지형 생성을 담당한다.
 *  - 블록 데이터는 1차원 Uint8Array 하나에 저장 (메모리·속도 효율)
 *  - 시드 기반 의사난수 + 값 노이즈(value noise)로 지형과 나무를 생성
 *    → 같은 시드면 항상 같은 지형
 *  - 생성 직후 상태(baseBlocks)를 보관해 사용자 변경분만 계산/저장
 *  - 블록이 바뀌면 영향받는 청크를 dirty 로 표시해 렌더러가 해당 메시만 갱신
 */
(function () {
  'use strict';

  const MBW = window.MBW;
  const { CONFIG, BlockType } = MBW;

  // =========================================================
  // 시드 기반 난수 / 노이즈
  // =========================================================

  /** mulberry32 의사난수 생성기: 같은 시드 → 같은 수열 ([0,1) 실수) */
  function createRandom(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /** 정수 격자 좌표 (x, z)를 [0,1) 값으로 해시한다 */
  function hash2D(seed, x, z) {
    let h = (seed | 0) ^ Math.imul(x | 0, 374761393) ^ Math.imul(z | 0, 668265263);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  }

  /** 부드러운 보간 곡선 (3t² - 2t³) */
  function smoothstep(t) {
    return t * t * (3 - 2 * t);
  }

  function lerp(a, b, t) {
    return a + (b - a) * t;
  }

  /** 2D 값 노이즈: 격자점의 난수값을 부드럽게 보간 */
  function valueNoise2D(seed, x, z) {
    const x0 = Math.floor(x);
    const z0 = Math.floor(z);
    const tx = smoothstep(x - x0);
    const tz = smoothstep(z - z0);
    const a = hash2D(seed, x0, z0);
    const b = hash2D(seed, x0 + 1, z0);
    const c = hash2D(seed, x0, z0 + 1);
    const d = hash2D(seed, x0 + 1, z0 + 1);
    return lerp(lerp(a, b, tx), lerp(c, d, tx), tz);
  }

  /** 여러 주파수의 노이즈를 겹친 프랙탈 노이즈 (결과 0~1) */
  function fractalNoise2D(seed, x, z, octaves) {
    let sum = 0;
    let amplitude = 1;
    let frequency = 1;
    let total = 0;
    for (let i = 0; i < octaves; i++) {
      sum += valueNoise2D(seed + i * 1013, x * frequency, z * frequency) * amplitude;
      total += amplitude;
      amplitude *= 0.5;
      frequency *= 2;
    }
    return sum / total;
  }

  function clamp(v, min, max) {
    return Math.max(min, Math.min(max, v));
  }

  // =========================================================
  // World 클래스
  // =========================================================
  class World {
    /** @param {number} seed 지형 생성 시드 */
    constructor(seed) {
      this.seed = seed >>> 0;
      this.sizeX = CONFIG.WORLD_SIZE_X;
      this.sizeY = CONFIG.WORLD_HEIGHT;
      this.sizeZ = CONFIG.WORLD_SIZE_Z;
      const total = this.sizeX * this.sizeY * this.sizeZ;
      this.blocks = new Uint8Array(total);      // 현재 블록 상태
      this.baseBlocks = new Uint8Array(total);  // 시드로 생성된 원본 상태 (변경분 비교용)

      this.chunkCountX = Math.ceil(this.sizeX / CONFIG.CHUNK_SIZE);
      this.chunkCountZ = Math.ceil(this.sizeZ / CONFIG.CHUNK_SIZE);
      this.dirtyChunks = new Set();             // 메시 재생성이 필요한 청크 번호
      this.changeListeners = [];
    }

    // ---------------------------------------------------------
    // 기본 접근
    // ---------------------------------------------------------

    /** (x, y, z) → 1차원 배열 인덱스. 같은 높이의 블록이 연속 배치된다 */
    index(x, y, z) {
      return x + this.sizeX * (z + this.sizeZ * y);
    }

    /** 좌표가 월드 범위 안인지 확인 */
    inBounds(x, y, z) {
      return x >= 0 && x < this.sizeX && y >= 0 && y < this.sizeY && z >= 0 && z < this.sizeZ;
    }

    /** 블록 ID를 읽는다. 범위 밖은 공기로 취급 */
    getBlock(x, y, z) {
      if (!this.inBounds(x, y, z)) return BlockType.AIR;
      return this.blocks[this.index(x, y, z)];
    }

    /**
     * 물리 충돌용 고체 판정.
     * 월드 바닥 아래와 가로 경계 바깥은 보이지 않는 벽으로 막아
     * 플레이어가 월드 밖으로 떨어지지 않게 한다.
     */
    isSolidForPhysics(x, y, z) {
      if (y < 0) return true;
      if (x < 0 || x >= this.sizeX || z < 0 || z >= this.sizeZ) return true;
      if (y >= this.sizeY) return false;
      return this.blocks[this.index(x, y, z)] !== BlockType.AIR;
    }

    /** (x, z) 기둥에서 가장 높은 블록의 y (없으면 -1) */
    getTopSolidY(x, z) {
      for (let y = this.sizeY - 1; y >= 0; y--) {
        if (this.getBlock(x, y, z) !== BlockType.AIR) return y;
      }
      return -1;
    }

    /**
     * 플레이어 조작으로 블록을 바꾼다.
     * 변경되면 관련 청크를 dirty 로 표시하고 리스너(자동 저장 등)에 알린다.
     * @returns {boolean} 실제로 변경되었는지
     */
    setBlock(x, y, z, type) {
      if (!this.inBounds(x, y, z) || !MBW.isValidBlockType(type)) return false;
      const i = this.index(x, y, z);
      const previous = this.blocks[i];
      if (previous === type) return false;
      this.blocks[i] = type;
      this.markDirtyAround(x, z);
      const change = { x, y, z, type, previous };
      this.changeListeners.forEach((fn) => fn(change));
      return true;
    }

    /** 블록 변경 리스너 등록 */
    onChange(listener) {
      this.changeListeners.push(listener);
    }

    /** 생성 단계에서 쓰는 내부용 쓰기 (dirty 표시/알림 없음) */
    _setRaw(x, y, z, type) {
      if (this.inBounds(x, y, z)) this.blocks[this.index(x, y, z)] = type;
    }

    // ---------------------------------------------------------
    // 청크 dirty 관리
    // ---------------------------------------------------------

    /** 블록 좌표가 속한 청크 번호 */
    chunkIndexAt(x, z) {
      const cx = Math.floor(x / CONFIG.CHUNK_SIZE);
      const cz = Math.floor(z / CONFIG.CHUNK_SIZE);
      return cx + cz * this.chunkCountX;
    }

    /**
     * (x, z) 주변 1칸 이내에 걸친 모든 청크를 dirty 로 표시한다.
     * 경계 블록이 바뀌면 이웃 청크의 면 노출/AO 도 달라지기 때문이다.
     */
    markDirtyAround(x, z) {
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const nz = z + dz;
          if (nx < 0 || nz < 0 || nx >= this.sizeX || nz >= this.sizeZ) continue;
          this.dirtyChunks.add(this.chunkIndexAt(nx, nz));
        }
      }
    }

    /** 모든 청크를 dirty 로 표시 */
    markAllDirty() {
      for (let i = 0; i < this.chunkCountX * this.chunkCountZ; i++) this.dirtyChunks.add(i);
    }

    // ---------------------------------------------------------
    // 지형 생성
    // ---------------------------------------------------------

    /** 시드로 지형과 나무를 생성하고 원본 상태로 보관한다 */
    generate() {
      this.blocks.fill(BlockType.AIR);
      const heights = this._generateTerrain();
      this._generateTrees(heights);
      this.baseBlocks.set(this.blocks);
      this.markAllDirty();
    }

    /** (x, z) 위치의 지면 높이를 노이즈로 계산 */
    terrainHeightAt(x, z) {
      const n = fractalNoise2D(this.seed, x * CONFIG.TERRAIN_NOISE_SCALE, z * CONFIG.TERRAIN_NOISE_SCALE,
        CONFIG.TERRAIN_OCTAVES);
      // 0~1 노이즈를 -1~1 로 바꾼 뒤 진폭을 곱해 언덕/골짜기를 만든다
      const h = Math.round(CONFIG.TERRAIN_BASE_HEIGHT + (n * 2 - 1) * CONFIG.TERRAIN_AMPLITUDE);
      // 바닥층과 나무가 들어갈 위쪽 공간을 확보
      return clamp(h, CONFIG.DIRT_DEPTH + 1, this.sizeY - CONFIG.TREE_TRUNK_MAX - 4);
    }

    /** 잔디(맨 위) → 흙(DIRT_DEPTH 층) → 돌(그 아래) 지층을 채운다 */
    _generateTerrain() {
      const heights = new Int32Array(this.sizeX * this.sizeZ);
      for (let z = 0; z < this.sizeZ; z++) {
        for (let x = 0; x < this.sizeX; x++) {
          const h = this.terrainHeightAt(x, z);
          heights[x + z * this.sizeX] = h;
          for (let y = 0; y <= h; y++) {
            let type = BlockType.STONE;
            if (y === h) type = BlockType.GRASS;
            else if (y >= h - CONFIG.DIRT_DEPTH) type = BlockType.DIRT;
            this._setRaw(x, y, z, type);
          }
        }
      }
      return heights;
    }

    /** 시드 난수로 나무 위치를 정하고 서로 너무 가깝지 않게 배치 */
    _generateTrees(heights) {
      const random = createRandom(this.seed ^ 0x5bd1e995);
      const margin = CONFIG.TREE_EDGE_MARGIN;
      const placed = [];
      for (let z = margin; z < this.sizeZ - margin; z++) {
        for (let x = margin; x < this.sizeX - margin; x++) {
          if (random() >= CONFIG.TREE_DENSITY) continue;
          const tooClose = placed.some((t) =>
            Math.max(Math.abs(t.x - x), Math.abs(t.z - z)) < CONFIG.TREE_MIN_SPACING);
          if (tooClose) continue;
          const groundY = heights[x + z * this.sizeX];
          const range = CONFIG.TREE_TRUNK_MAX - CONFIG.TREE_TRUNK_MIN + 1;
          const trunkHeight = CONFIG.TREE_TRUNK_MIN + Math.floor(random() * range);
          if (groundY + trunkHeight + 2 >= this.sizeY) continue;
          this._placeTree(x, groundY, z, trunkHeight, random);
          placed.push({ x, z });
        }
      }
    }

    /**
     * 나무 한 그루를 만든다.
     * 줄기 위쪽 두 층은 반경 2, 꼭대기 두 층은 반경 1의 잎으로 감싼다.
     */
    _placeTree(x, groundY, z, trunkHeight, random) {
      this._setRaw(x, groundY, z, BlockType.DIRT); // 나무 밑은 흙
      const topY = groundY + trunkHeight;
      for (let y = groundY + 1; y <= topY; y++) this._setRaw(x, y, z, BlockType.WOOD);

      for (let ly = topY - 2; ly <= topY + 1; ly++) {
        const radius = ly < topY ? 2 : 1;
        for (let dz = -radius; dz <= radius; dz++) {
          for (let dx = -radius; dx <= radius; dx++) {
            const isCorner = Math.abs(dx) === radius && Math.abs(dz) === radius;
            // 모서리는 꼭대기에선 항상, 그 외엔 50% 확률로 비워 둥근 모양을 만든다
            if (isCorner && (ly === topY + 1 || random() < 0.5)) continue;
            const bx = x + dx;
            const bz = z + dz;
            if (this.inBounds(bx, ly, bz) && this.getBlock(bx, ly, bz) === BlockType.AIR) {
              this._setRaw(bx, ly, bz, BlockType.LEAVES);
            }
          }
        }
      }
    }

    // ---------------------------------------------------------
    // 저장용 변경분
    // ---------------------------------------------------------

    /**
     * 원본(시드 생성) 대비 바뀐 블록 목록을 [x, y, z, type, ...] 평면 배열로 반환.
     * 추가(공기→블록)와 제거(블록→공기)가 모두 포함된다.
     */
    getChanges() {
      const changes = [];
      const layer = this.sizeX * this.sizeZ;
      for (let i = 0; i < this.blocks.length; i++) {
        if (this.blocks[i] === this.baseBlocks[i]) continue;
        const x = i % this.sizeX;
        const z = Math.floor(i / this.sizeX) % this.sizeZ;
        const y = Math.floor(i / layer);
        changes.push(x, y, z, this.blocks[i]);
      }
      return changes;
    }

    /** 저장된 변경분을 현재 월드에 적용 (리스너 알림 없음) */
    applyChanges(changes) {
      for (let i = 0; i + 3 < changes.length; i += 4) {
        const [x, y, z, type] = [changes[i], changes[i + 1], changes[i + 2], changes[i + 3]];
        if (this.inBounds(x, y, z) && MBW.isValidBlockType(type)) this._setRaw(x, y, z, type);
      }
      this.markAllDirty();
    }
  }

  MBW.World = World;
  MBW.createRandom = createRandom;
})();
