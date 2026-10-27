/**
 * renderer.js
 * ------------------------------------------------------------
 * WebGL 렌더링을 담당한다.
 *  - 외부 라이브러리 없이 구현한 벡터/행렬 연산(MBW.Vec3, MBW.Mat4)
 *  - 셰이더 컴파일, 청크 단위 지형 메시 생성/갱신
 *  - 투영·뷰 행렬 카메라, 절두체 컬링, 조준 블록 강조 표시
 *
 * 렌더러는 월드 데이터를 "읽기만" 하며, 플레이어 이동이나 물리와는 분리되어 있다.
 */
(function () {
  'use strict';

  const MBW = window.MBW;
  const { CONFIG, BlockType, Pattern } = MBW;

  // =========================================================
  // 벡터 / 행렬 유틸리티 (열 우선 column-major, WebGL 규약)
  // =========================================================

  const Vec3 = {
    /** a - b */
    subtract(a, b) {
      return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
    },
    /** a + b */
    add(a, b) {
      return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
    },
    /** 스칼라 곱 */
    scale(a, s) {
      return [a[0] * s, a[1] * s, a[2] * s];
    },
    /** 내적 */
    dot(a, b) {
      return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    },
    /** 외적 */
    cross(a, b) {
      return [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
      ];
    },
    /** 벡터 길이 */
    length(a) {
      return Math.hypot(a[0], a[1], a[2]);
    },
    /** 단위 벡터로 정규화 (길이가 0이면 영벡터) */
    normalize(a) {
      const len = Vec3.length(a);
      return len > 0 ? [a[0] / len, a[1] / len, a[2] / len] : [0, 0, 0];
    },
    /**
     * yaw(좌우)/pitch(상하) 각도로 바라보는 방향 벡터를 만든다.
     * yaw = 0 이면 -Z 방향(북쪽)을 바라본다.
     */
    fromYawPitch(yaw, pitch) {
      const cp = Math.cos(pitch);
      return [-Math.sin(yaw) * cp, Math.sin(pitch), -Math.cos(yaw) * cp];
    },
  };

  const Mat4 = {
    /** 단위 행렬 생성 */
    create() {
      const m = new Float32Array(16);
      m[0] = m[5] = m[10] = m[15] = 1;
      return m;
    },

    /** 원근 투영 행렬 */
    perspective(out, fovY, aspect, near, far) {
      const f = 1 / Math.tan(fovY / 2);
      const nf = 1 / (near - far);
      out.fill(0);
      out[0] = f / aspect;
      out[5] = f;
      out[10] = (far + near) * nf;
      out[11] = -1;
      out[14] = 2 * far * near * nf;
      return out;
    },

    /** 카메라 위치(eye)에서 대상(center)을 바라보는 뷰 행렬 */
    lookAt(out, eye, center, up) {
      const f = Vec3.normalize(Vec3.subtract(center, eye)); // 전방
      const s = Vec3.normalize(Vec3.cross(f, up));          // 오른쪽
      const u = Vec3.cross(s, f);                           // 위쪽
      out[0] = s[0]; out[1] = u[0]; out[2] = -f[0]; out[3] = 0;
      out[4] = s[1]; out[5] = u[1]; out[6] = -f[1]; out[7] = 0;
      out[8] = s[2]; out[9] = u[2]; out[10] = -f[2]; out[11] = 0;
      out[12] = -Vec3.dot(s, eye);
      out[13] = -Vec3.dot(u, eye);
      out[14] = Vec3.dot(f, eye);
      out[15] = 1;
      return out;
    },

    /** out = a × b (out 이 a, b 와 같아도 안전하도록 임시 배열 사용) */
    multiply(out, a, b) {
      const r = Mat4._tmp;
      for (let col = 0; col < 4; col++) {
        for (let row = 0; row < 4; row++) {
          let sum = 0;
          for (let k = 0; k < 4; k++) sum += a[k * 4 + row] * b[col * 4 + k];
          r[col * 4 + row] = sum;
        }
      }
      out.set(r);
      return out;
    },
    _tmp: new Float32Array(16),
  };

  MBW.Vec3 = Vec3;
  MBW.Mat4 = Mat4;

  // =========================================================
  // 큐브 면 정의
  // 각 면의 네 꼭짓점은 "면 바깥에서 볼 때 반시계 방향(CCW)" 순서이다.
  // 순서: 왼쪽아래, 오른쪽아래, 오른쪽위, 왼쪽위 → UV (0,0) (1,0) (1,1) (0,1)
  // =========================================================
  const FACES = [
    { dir: [1, 0, 0], kind: 'side', shade: CONFIG.FACE_SHADE.x,
      corners: [[1, 0, 1], [1, 0, 0], [1, 1, 0], [1, 1, 1]] },   // +X (동)
    { dir: [-1, 0, 0], kind: 'side', shade: CONFIG.FACE_SHADE.x,
      corners: [[0, 0, 0], [0, 0, 1], [0, 1, 1], [0, 1, 0]] },   // -X (서)
    { dir: [0, 1, 0], kind: 'top', shade: CONFIG.FACE_SHADE.top,
      corners: [[0, 1, 1], [1, 1, 1], [1, 1, 0], [0, 1, 0]] },   // +Y (위)
    { dir: [0, -1, 0], kind: 'bottom', shade: CONFIG.FACE_SHADE.bottom,
      corners: [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]] },   // -Y (아래)
    { dir: [0, 0, 1], kind: 'side', shade: CONFIG.FACE_SHADE.z,
      corners: [[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]] },   // +Z (남)
    { dir: [0, 0, -1], kind: 'side', shade: CONFIG.FACE_SHADE.z,
      corners: [[1, 0, 0], [0, 0, 0], [0, 1, 0], [1, 1, 0]] },   // -Z (북)
  ];
  const FACE_UVS = [[0, 0], [1, 0], [1, 1], [0, 1]];

  // 앰비언트 오클루전 계산에 필요한 면별 접선 축(법선 축을 제외한 두 축)을 미리 계산
  FACES.forEach((face) => {
    const normalAxis = face.dir.findIndex((v) => v !== 0);
    face.tangentAxes = [0, 1, 2].filter((axis) => axis !== normalAxis);
  });

  // 정점 하나의 float 개수: 위치3 + 색상3 + UV2 + 정보3(무늬, 시드, 밝기)
  const FLOATS_PER_VERTEX = 11;
  const STRIDE = FLOATS_PER_VERTEX * 4;

  // 셰이더 attribute 위치 (두 프로그램이 같은 위치를 쓰도록 고정)
  const ATTR = { position: 0, color: 1, uv: 2, info: 3 };

  // =========================================================
  // 셰이더 소스
  // =========================================================
  const BLOCK_VS = `
    attribute vec3 aPosition;
    attribute vec3 aColor;
    attribute vec2 aUV;
    attribute vec3 aInfo;        // x: 무늬 종류, y: 블록별 노이즈 시드, z: 면 밝기 × AO
    uniform mat4 uViewProj;
    varying vec3 vColor;
    varying vec2 vUV;
    varying vec3 vInfo;
    varying vec3 vWorldPos;
    void main() {
      vColor = aColor;
      vUV = aUV;
      vInfo = aInfo;
      vWorldPos = aPosition;
      gl_Position = uViewProj * vec4(aPosition, 1.0);
    }
  `;

  // 외부 텍스처 없이 UV를 16×16 픽셀 격자로 나눠 블록 무늬를 절차적으로 만든다.
  const BLOCK_FS = `
    precision highp float;
    varying vec3 vColor;
    varying vec2 vUV;
    varying vec3 vInfo;
    varying vec3 vWorldPos;
    uniform vec3 uCameraPos;
    uniform vec3 uFogColor;
    uniform vec2 uFogRange;
    uniform vec3 uGrassColor;
    uniform vec3 uBarkColor;

    float hash(vec2 p) {
      return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
    }

    void main() {
      vec2 px = floor(clamp(vUV, 0.0, 0.999) * 16.0);   // 16×16 픽셀 좌표
      float seed = vInfo.y;
      float n = hash(px + vec2(seed, seed * 0.73));
      float pattern = floor(vInfo.x + 0.5);
      vec3 color = vColor;
      float tone = 0.92 + n * 0.16;                     // 기본 픽셀 명암 변화

      if (pattern == 1.0) {
        // 잔디 옆면: 위쪽 몇 줄을 불규칙한 경계로 잔디색 처리
        float edge = 12.0 + floor(hash(vec2(px.x, seed + 5.0)) * 3.0);
        if (px.y >= edge) color = uGrassColor;
      } else if (pattern == 2.0) {
        // 나뭇잎: 어두운 구멍 느낌의 점
        tone = n < 0.22 ? 0.68 : 0.9 + n * 0.2;
      } else if (pattern == 3.0) {
        // 나무 옆면: 세로 줄무늬
        float stripe = hash(vec2(px.x, seed));
        tone = 0.8 + stripe * 0.22 + n * 0.06;
      } else if (pattern == 4.0) {
        // 나무 단면: 바깥 테두리는 껍질, 안쪽은 나이테
        float d = max(abs(px.x - 7.5), abs(px.y - 7.5));
        if (d > 6.0) {
          color = uBarkColor;
        } else {
          tone = (mod(floor(d), 3.0) < 1.0 ? 0.84 : 1.0) * (0.96 + n * 0.08);
        }
      } else if (pattern == 5.0) {
        // 돌: 대비가 큰 노이즈
        tone = 0.8 + n * 0.32;
      }

      color *= tone * vInfo.z;

      // 거리 기반 안개 (월드 경계가 하늘과 자연스럽게 섞이도록)
      float dist = distance(vWorldPos, uCameraPos);
      float fog = smoothstep(uFogRange.x, uFogRange.y, dist);
      gl_FragColor = vec4(mix(color, uFogColor, fog), 1.0);
    }
  `;

  // 조준 블록 강조: 반투명 면 + 굵은 테두리를 UV로 그린다
  const HIGHLIGHT_VS = `
    attribute vec3 aPosition;
    attribute vec2 aUV;
    uniform mat4 uViewProj;
    uniform vec3 uOffset;
    uniform float uScale;
    varying vec2 vUV;
    void main() {
      vUV = aUV;
      gl_Position = uViewProj * vec4(aPosition * uScale + uOffset, 1.0);
    }
  `;

  const HIGHLIGHT_FS = `
    precision mediump float;
    varying vec2 vUV;
    uniform vec4 uFillColor;
    uniform vec4 uEdgeColor;
    uniform float uEdgeWidth;
    void main() {
      float edge = min(min(vUV.x, 1.0 - vUV.x), min(vUV.y, 1.0 - vUV.y));
      gl_FragColor = edge < uEdgeWidth ? uEdgeColor : uFillColor;
    }
  `;

  // =========================================================
  // WebGL 헬퍼
  // =========================================================

  /** 셰이더를 컴파일하고 오류가 있으면 예외를 던진다 */
  function compileShader(gl, type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(shader);
      gl.deleteShader(shader);
      throw new Error('셰이더 컴파일 실패: ' + log);
    }
    return shader;
  }

  /** 정점/프래그먼트 셰이더를 링크하고, 사용할 uniform 위치를 조회한다 */
  function createProgram(gl, vsSource, fsSource, attributes, uniforms) {
    const program = gl.createProgram();
    gl.attachShader(program, compileShader(gl, gl.VERTEX_SHADER, vsSource));
    gl.attachShader(program, compileShader(gl, gl.FRAGMENT_SHADER, fsSource));
    // attribute 위치를 고정해 프로그램 간 정점 속성 설정을 일관되게 유지
    Object.entries(attributes).forEach(([name, location]) => gl.bindAttribLocation(program, location, name));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error('셰이더 링크 실패: ' + gl.getProgramInfoLog(program));
    }
    const u = {};
    uniforms.forEach((name) => { u[name] = gl.getUniformLocation(program, name); });
    return { program, u };
  }

  /** 블록 좌표로 0~64 범위의 고정 시드를 만든다 (셰이더 노이즈용) */
  function blockSeed(x, y, z, faceIndex) {
    let h = Math.imul(x, 73856093) ^ Math.imul(y, 19349663) ^ Math.imul(z, 83492791) ^ Math.imul(faceIndex + 1, 2654435761);
    h = Math.imul(h ^ (h >>> 15), 2246822519);
    return ((h >>> 0) % 4096) / 64;
  }

  // =========================================================
  // Renderer 클래스
  // =========================================================
  class Renderer {
    /** @param {HTMLCanvasElement} canvas */
    constructor(canvas) {
      this.canvas = canvas;
      this.gl = null;
      this.world = null;
      this.chunkMeshes = new Map();   // 청크 번호 → { vbo, ibo, indexCount, indexType, min, max }
      this.projMatrix = Mat4.create();
      this.viewMatrix = Mat4.create();
      this.viewProjMatrix = Mat4.create();
      this.frustumPlanes = new Float32Array(24);
      this.contextLost = false;
      this.stats = { chunks: 0, visibleChunks: 0, triangles: 0, lastRebuildMs: 0 };
    }

    /** WebGL 컨텍스트를 만들고 셰이더/버퍼를 준비한다. 실패하면 예외 */
    init() {
      const gl = this.canvas.getContext('webgl', {
        antialias: true,
        alpha: false,
        depth: true,
        powerPreference: 'high-performance',
      });
      if (!gl) throw new Error('이 브라우저에서 WebGL을 사용할 수 없습니다.');
      this.gl = gl;

      // 컨텍스트 손실/복구 처리 (GPU 드라이버 리셋 등)
      this.canvas.addEventListener('webglcontextlost', (e) => {
        e.preventDefault();
        this.contextLost = true;
      });
      this.canvas.addEventListener('webglcontextrestored', () => {
        this.contextLost = false;
        this.chunkMeshes.clear();
        this._setupResources();
        if (this.world) this.rebuildAll(this.world);
      });

      this._setupResources();
      this.resize();
    }

    /** 셰이더 프로그램, 강조 박스 버퍼, 기본 GL 상태 설정 */
    _setupResources() {
      const gl = this.gl;
      // 정점 수가 65535를 넘을 수 있는 경우를 대비한 32비트 인덱스 확장
      this.uintExt = gl.getExtension('OES_element_index_uint');

      this.blockProgram = createProgram(gl, BLOCK_VS, BLOCK_FS,
        { aPosition: ATTR.position, aColor: ATTR.color, aUV: ATTR.uv, aInfo: ATTR.info },
        ['uViewProj', 'uCameraPos', 'uFogColor', 'uFogRange', 'uGrassColor', 'uBarkColor']);

      this.highlightProgram = createProgram(gl, HIGHLIGHT_VS, HIGHLIGHT_FS,
        { aPosition: ATTR.position, aUV: ATTR.uv },
        ['uViewProj', 'uOffset', 'uScale', 'uFillColor', 'uEdgeColor', 'uEdgeWidth']);

      // 강조용 단위 큐브(36정점, 위치3 + UV2)
      const cube = [];
      FACES.forEach((face) => {
        [0, 1, 2, 0, 2, 3].forEach((i) => {
          cube.push(...face.corners[i], ...FACE_UVS[i]);
        });
      });
      this.highlightBuffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, this.highlightBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(cube), gl.STATIC_DRAW);

      // 깊이 테스트 + 뒷면 제거
      gl.enable(gl.DEPTH_TEST);
      gl.depthFunc(gl.LEQUAL);
      gl.enable(gl.CULL_FACE);
      gl.cullFace(gl.BACK);
      gl.frontFace(gl.CCW);
    }

    /** 캔버스 크기를 화면 크기(× 픽셀 비율)에 맞춘다 */
    resize() {
      const dpr = Math.min(window.devicePixelRatio || 1, CONFIG.MAX_PIXEL_RATIO);
      const width = Math.max(1, Math.floor(this.canvas.clientWidth * dpr));
      const height = Math.max(1, Math.floor(this.canvas.clientHeight * dpr));
      if (this.canvas.width !== width || this.canvas.height !== height) {
        this.canvas.width = width;
        this.canvas.height = height;
      }
    }

    // ---------------------------------------------------------
    // 메시 생성
    // ---------------------------------------------------------

    /** 모든 청크 메시를 다시 만든다 (월드 생성/초기화/불러오기 직후) */
    rebuildAll(world) {
      this.world = world;
      for (let cz = 0; cz < world.chunkCountZ; cz++) {
        for (let cx = 0; cx < world.chunkCountX; cx++) {
          this.buildChunkMesh(world, cx, cz);
        }
      }
      world.dirtyChunks.clear();
    }

    /**
     * 변경된(dirty) 청크만 다시 만든다. 블록 하나를 바꾸면 해당 청크와
     * 경계에 닿은 이웃 청크만 갱신되므로 전체 재생성보다 훨씬 빠르다.
     * @returns {number} 갱신한 청크 수
     */
    updateDirtyChunks(world) {
      if (this.contextLost || world.dirtyChunks.size === 0) return 0;
      this.world = world;
      const start = performance.now();
      let count = 0;
      world.dirtyChunks.forEach((chunkIndex) => {
        const cx = chunkIndex % world.chunkCountX;
        const cz = Math.floor(chunkIndex / world.chunkCountX);
        this.buildChunkMesh(world, cx, cz);
        count++;
      });
      world.dirtyChunks.clear();
      this.stats.lastRebuildMs = performance.now() - start;
      return count;
    }

    /**
     * 청크 하나의 메시를 만든다.
     * 핵심 최적화: 이웃이 비어 있는(공기) 면만 정점을 생성한다.
     * 블록끼리 맞닿은 내부 면은 절대 보이지 않으므로 버퍼에 넣지 않는다.
     */
    buildChunkMesh(world, cx, cz) {
      const gl = this.gl;
      const size = CONFIG.CHUNK_SIZE;
      const x0 = cx * size;
      const z0 = cz * size;
      const x1 = Math.min(x0 + size, world.sizeX);
      const z1 = Math.min(z0 + size, world.sizeZ);

      const vertices = [];
      const indices = [];
      let vertexCount = 0;

      // 면 가림 판정: 월드 바닥 아래는 막힌 것으로, 월드 밖 옆/위는 빈 것으로 본다
      const isOpaque = (x, y, z) => (y < 0 ? true : world.getBlock(x, y, z) !== BlockType.AIR);

      for (let y = 0; y < world.sizeY; y++) {
        for (let z = z0; z < z1; z++) {
          for (let x = x0; x < x1; x++) {
            const id = world.getBlock(x, y, z);
            if (id === BlockType.AIR) continue;
            const def = MBW.getBlockDef(id);
            if (!def) continue;

            for (let f = 0; f < FACES.length; f++) {
              const face = FACES[f];
              const nx = x + face.dir[0];
              const ny = y + face.dir[1];
              const nz = z + face.dir[2];
              if (isOpaque(nx, ny, nz)) continue; // 가려진 면은 생략

              const color = def[face.kind];
              const pattern = def.pattern[face.kind];
              const seed = blockSeed(x, y, z, f);
              const [ua, va] = face.tangentAxes;
              const ao = [0, 0, 0, 0];

              for (let c = 0; c < 4; c++) {
                const corner = face.corners[c];
                // 정점 AO: 면 앞쪽 칸에서 이 꼭짓점에 닿는 이웃 3칸을 검사
                const base = [nx, ny, nz];
                const sideA = base.slice();
                const sideB = base.slice();
                sideA[ua] += corner[ua] ? 1 : -1;
                sideB[va] += corner[va] ? 1 : -1;
                const diag = sideA.slice();
                diag[va] += corner[va] ? 1 : -1;
                const s1 = isOpaque(sideA[0], sideA[1], sideA[2]) ? 1 : 0;
                const s2 = isOpaque(sideB[0], sideB[1], sideB[2]) ? 1 : 0;
                const s3 = isOpaque(diag[0], diag[1], diag[2]) ? 1 : 0;
                ao[c] = s1 && s2 ? 0 : 3 - (s1 + s2 + s3);

                const light = face.shade * CONFIG.AO_LEVELS[ao[c]];
                const bs = CONFIG.BLOCK_SIZE;
                vertices.push(
                  (x + corner[0]) * bs, (y + corner[1]) * bs, (z + corner[2]) * bs,
                  color[0], color[1], color[2],
                  FACE_UVS[c][0], FACE_UVS[c][1],
                  pattern, seed, light
                );
              }

              // AO 값에 따라 사각형 대각선 방향을 골라 명암이 자연스럽게 보이도록 한다
              const v = vertexCount;
              if (ao[0] + ao[2] < ao[1] + ao[3]) {
                indices.push(v + 1, v + 2, v + 3, v + 1, v + 3, v);
              } else {
                indices.push(v, v + 1, v + 2, v, v + 2, v + 3);
              }
              vertexCount += 4;
            }
          }
        }
      }

      const chunkIndex = cx + cz * world.chunkCountX;
      let mesh = this.chunkMeshes.get(chunkIndex);
      if (!mesh) {
        mesh = {
          vbo: gl.createBuffer(),
          ibo: gl.createBuffer(),
          indexCount: 0,
          indexType: gl.UNSIGNED_SHORT,
          min: [x0 * CONFIG.BLOCK_SIZE, 0, z0 * CONFIG.BLOCK_SIZE],
          max: [x1 * CONFIG.BLOCK_SIZE, world.sizeY * CONFIG.BLOCK_SIZE, z1 * CONFIG.BLOCK_SIZE],
        };
        this.chunkMeshes.set(chunkIndex, mesh);
      }

      // 정점 수에 맞는 인덱스 타입 선택
      let indexArray;
      if (vertexCount > 65535 && this.uintExt) {
        indexArray = new Uint32Array(indices);
        mesh.indexType = gl.UNSIGNED_INT;
      } else {
        indexArray = new Uint16Array(indices);
        mesh.indexType = gl.UNSIGNED_SHORT;
      }

      gl.bindBuffer(gl.ARRAY_BUFFER, mesh.vbo);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(vertices), gl.STATIC_DRAW);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, mesh.ibo);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indexArray, gl.STATIC_DRAW);
      mesh.indexCount = indices.length;
    }

    // ---------------------------------------------------------
    // 절두체 컬링
    // ---------------------------------------------------------

    /** 뷰-투영 행렬에서 절두체 6개 평면을 추출한다 */
    _updateFrustum(m) {
      const p = this.frustumPlanes;
      const setPlane = (i, a, b, c, d) => {
        const len = Math.hypot(a, b, c) || 1;
        p[i * 4] = a / len; p[i * 4 + 1] = b / len; p[i * 4 + 2] = c / len; p[i * 4 + 3] = d / len;
      };
      setPlane(0, m[3] + m[0], m[7] + m[4], m[11] + m[8], m[15] + m[12]);  // 왼쪽
      setPlane(1, m[3] - m[0], m[7] - m[4], m[11] - m[8], m[15] - m[12]);  // 오른쪽
      setPlane(2, m[3] + m[1], m[7] + m[5], m[11] + m[9], m[15] + m[13]);  // 아래
      setPlane(3, m[3] - m[1], m[7] - m[5], m[11] - m[9], m[15] - m[13]);  // 위
      setPlane(4, m[3] + m[2], m[7] + m[6], m[11] + m[10], m[15] + m[14]); // 가까운 면
      setPlane(5, m[3] - m[2], m[7] - m[6], m[11] - m[10], m[15] - m[14]); // 먼 면
    }

    /** AABB가 절두체 안에 조금이라도 들어오는지 검사 */
    _isBoxVisible(min, max) {
      const p = this.frustumPlanes;
      for (let i = 0; i < 6; i++) {
        const a = p[i * 4], b = p[i * 4 + 1], c = p[i * 4 + 2], d = p[i * 4 + 3];
        // 평면 법선 방향으로 가장 먼 꼭짓점이 평면 뒤에 있으면 완전히 밖
        const px = a >= 0 ? max[0] : min[0];
        const py = b >= 0 ? max[1] : min[1];
        const pz = c >= 0 ? max[2] : min[2];
        if (a * px + b * py + c * pz + d < 0) return false;
      }
      return true;
    }

    // ---------------------------------------------------------
    // 그리기
    // ---------------------------------------------------------

    /**
     * 한 프레임을 그린다.
     * @param {{position:number[], forward:number[]}} camera 카메라 위치와 바라보는 방향
     * @param {{x:number,y:number,z:number}|null} highlight 강조할 블록
     */
    render(camera, highlight) {
      const gl = this.gl;
      if (!gl || this.contextLost) return;

      this.resize();
      const width = this.canvas.width;
      const height = this.canvas.height;
      gl.viewport(0, 0, width, height);
      const sky = CONFIG.SKY_COLOR;
      gl.clearColor(sky[0], sky[1], sky[2], 1);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

      // 카메라 행렬: 투영 × 뷰
      Mat4.perspective(this.projMatrix, (CONFIG.FOV_DEG * Math.PI) / 180, width / height,
        CONFIG.NEAR_PLANE, CONFIG.FAR_PLANE);
      Mat4.lookAt(this.viewMatrix, camera.position, Vec3.add(camera.position, camera.forward), [0, 1, 0]);
      Mat4.multiply(this.viewProjMatrix, this.projMatrix, this.viewMatrix);
      this._updateFrustum(this.viewProjMatrix);

      // ---- 지형 ----
      const bp = this.blockProgram;
      gl.useProgram(bp.program);
      gl.uniformMatrix4fv(bp.u.uViewProj, false, this.viewProjMatrix);
      gl.uniform3fv(bp.u.uCameraPos, camera.position);
      gl.uniform3fv(bp.u.uFogColor, sky);
      gl.uniform2f(bp.u.uFogRange, CONFIG.FOG_NEAR, CONFIG.FOG_FAR);
      gl.uniform3fv(bp.u.uGrassColor, MBW.BLOCKS[BlockType.GRASS].top);
      gl.uniform3fv(bp.u.uBarkColor, MBW.BLOCKS[BlockType.WOOD].side);

      gl.enableVertexAttribArray(ATTR.position);
      gl.enableVertexAttribArray(ATTR.color);
      gl.enableVertexAttribArray(ATTR.uv);
      gl.enableVertexAttribArray(ATTR.info);

      let visible = 0;
      let triangles = 0;
      this.chunkMeshes.forEach((mesh) => {
        if (mesh.indexCount === 0 || !this._isBoxVisible(mesh.min, mesh.max)) return;
        gl.bindBuffer(gl.ARRAY_BUFFER, mesh.vbo);
        gl.vertexAttribPointer(ATTR.position, 3, gl.FLOAT, false, STRIDE, 0);
        gl.vertexAttribPointer(ATTR.color, 3, gl.FLOAT, false, STRIDE, 12);
        gl.vertexAttribPointer(ATTR.uv, 2, gl.FLOAT, false, STRIDE, 24);
        gl.vertexAttribPointer(ATTR.info, 3, gl.FLOAT, false, STRIDE, 32);
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, mesh.ibo);
        gl.drawElements(gl.TRIANGLES, mesh.indexCount, mesh.indexType, 0);
        visible++;
        triangles += mesh.indexCount / 3;
      });
      this.stats.chunks = this.chunkMeshes.size;
      this.stats.visibleChunks = visible;
      this.stats.triangles = triangles;

      // 다른 프로그램이 쓰지 않는 속성은 꺼 둔다
      gl.disableVertexAttribArray(ATTR.color);
      gl.disableVertexAttribArray(ATTR.info);

      if (highlight) this._drawHighlight(highlight);
    }

    /** 조준 중인 블록에 반투명 면과 테두리를 그린다 */
    _drawHighlight(target) {
      const gl = this.gl;
      const hp = this.highlightProgram;
      const pad = CONFIG.HIGHLIGHT_PADDING;
      const bs = CONFIG.BLOCK_SIZE;

      gl.useProgram(hp.program);
      gl.uniformMatrix4fv(hp.u.uViewProj, false, this.viewProjMatrix);
      gl.uniform3f(hp.u.uOffset, target.x * bs - pad, target.y * bs - pad, target.z * bs - pad);
      gl.uniform1f(hp.u.uScale, bs + pad * 2);
      gl.uniform4f(hp.u.uFillColor, 1, 1, 1, 0.16);
      gl.uniform4f(hp.u.uEdgeColor, 0.05, 0.05, 0.05, 0.85);
      gl.uniform1f(hp.u.uEdgeWidth, 0.035);

      gl.bindBuffer(gl.ARRAY_BUFFER, this.highlightBuffer);
      gl.vertexAttribPointer(ATTR.position, 3, gl.FLOAT, false, 20, 0);
      gl.vertexAttribPointer(ATTR.uv, 2, gl.FLOAT, false, 20, 12);

      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.depthMask(false);
      gl.drawArrays(gl.TRIANGLES, 0, 36);
      gl.depthMask(true);
      gl.disable(gl.BLEND);
    }
  }

  MBW.Renderer = Renderer;
})();
