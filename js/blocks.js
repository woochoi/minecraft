/**
 * blocks.js
 * ------------------------------------------------------------
 * 게임 전역 네임스페이스(MBW), 공통 상수, 블록 종류 정의를 담당한다.
 *
 * ES 모듈 대신 일반 <script> 태그로 로드되므로(file:// 직접 실행 지원)
 * 모든 기능은 window.MBW 객체 아래에 등록한다.
 * 다른 스크립트가 이 파일의 상수를 사용하므로 가장 먼저 로드되어야 한다.
 */
(function () {
  'use strict';

  // 전역 네임스페이스. 이미 있으면 재사용한다.
  const MBW = (window.MBW = window.MBW || {});

  /**
   * 게임 전반에서 사용하는 상수 모음.
   * 좌표 단위는 "블록"이며 1 단위 = 블록 한 칸(BLOCK_SIZE)이다.
   */
  MBW.CONFIG = Object.freeze({
    // ---------- 월드 ----------
    WORLD_SIZE_X: 24,          // 가로 블록 수
    WORLD_SIZE_Z: 24,          // 세로 블록 수
    WORLD_HEIGHT: 32,          // 높이 방향 최대 블록 수
    BLOCK_SIZE: 1,             // 블록 한 변의 길이 (월드 좌표계의 기준 단위)
    CHUNK_SIZE: 8,             // 메시를 나누는 청크의 가로/세로 블록 수
    DEFAULT_SEED: 1027,        // URL에 ?seed= 가 없을 때 사용하는 시드

    // ---------- 지형 생성 ----------
    TERRAIN_BASE_HEIGHT: 8,    // 평균 지면 높이
    TERRAIN_AMPLITUDE: 7,      // 지면 높이 변화 폭
    TERRAIN_NOISE_SCALE: 0.075,// 노이즈 확대 비율 (작을수록 완만한 언덕)
    TERRAIN_OCTAVES: 4,        // 프랙탈 노이즈 겹 수
    DIRT_DEPTH: 3,             // 잔디 아래 흙층 두께
    TREE_DENSITY: 0.03,        // 칸마다 나무가 생길 확률
    TREE_EDGE_MARGIN: 2,       // 월드 가장자리에서 나무를 띄울 거리
    TREE_MIN_SPACING: 4,       // 나무 사이 최소 간격
    TREE_TRUNK_MIN: 4,         // 줄기 최소 높이
    TREE_TRUNK_MAX: 5,         // 줄기 최대 높이
    MIN_BREAKABLE_Y: 1,        // 이 높이 미만(맨 아래층)은 파괴 불가 → 월드에 구멍이 나지 않음

    // ---------- 플레이어 ----------
    PLAYER_WIDTH: 0.6,         // 충돌 박스 가로/세로
    PLAYER_HEIGHT: 1.8,        // 충돌 박스 높이
    PLAYER_EYE_HEIGHT: 1.62,   // 발 기준 눈 높이
    MOVE_SPEED: 4.6,           // 이동 속도 (블록/초)
    JUMP_VELOCITY: 8.2,        // 점프 초기 속도 (약 1.3블록 높이)
    GRAVITY: 26,               // 중력 가속도 (블록/초²)
    MAX_FALL_SPEED: 40,        // 최대 낙하 속도
    GROUND_ACCEL: 14,          // 지상에서 목표 속도에 도달하는 빠르기
    AIR_ACCEL: 4,              // 공중에서의 방향 전환 빠르기
    MOUSE_SENSITIVITY: 0.0022, // 마우스 감도 (라디안/픽셀)
    MAX_PITCH: Math.PI / 2 - 0.01, // 위/아래 시점 최대 각도
    RESPAWN_Y: -20,            // 이 높이 아래로 떨어지면 리스폰
    REACH_DISTANCE: 5,         // 블록 조작 가능 최대 거리

    // ---------- 블록 조작 ----------
    ACTION_REPEAT_DELAY: 0.3,    // 마우스를 누르고 있을 때 첫 반복까지 대기(초)
    ACTION_REPEAT_INTERVAL: 0.22,// 이후 반복 간격(초)

    // ---------- 렌더링 ----------
    FOV_DEG: 70,
    NEAR_PLANE: 0.05,
    FAR_PLANE: 200,
    FOG_NEAR: 30,
    FOG_FAR: 70,
    SKY_COLOR: [0.53, 0.78, 0.98],
    MAX_PIXEL_RATIO: 2,          // 고해상도 화면에서 렌더 해상도 상한
    AO_LEVELS: [0.5, 0.68, 0.84, 1.0], // 앰비언트 오클루전 밝기 단계
    FACE_SHADE: { top: 1.0, bottom: 0.5, x: 0.8, z: 0.66 }, // 면 방향별 밝기
    HIGHLIGHT_PADDING: 0.004,    // 조준 블록 강조 박스 여유

    // ---------- 게임 루프 ----------
    PHYSICS_STEP: 1 / 120,       // 고정 물리 시간 간격(초)
    MAX_FRAME_TIME: 0.25,        // 한 프레임 최대 경과 시간(탭 전환 후 급격한 이동 방지)
    MAX_PHYSICS_STEPS: 30,       // 한 프레임 최대 물리 스텝 수
    HUD_UPDATE_INTERVAL: 0.1,    // 좌표 표시 갱신 간격(초)
    FPS_UPDATE_INTERVAL: 0.5,    // FPS 표시 갱신 간격(초)

    // ---------- 저장 ----------
    STORAGE_KEY_PREFIX: 'miniBlockWorld.save.v1.seed.',
    SAVE_VERSION: 1,
    AUTOSAVE_DELAY_MS: 1500,     // 마지막 변경 후 자동 저장까지 대기
  });

  /** 블록 종류 ID (저장 데이터에도 이 숫자가 기록된다) */
  MBW.BlockType = Object.freeze({
    AIR: 0,
    GRASS: 1,
    DIRT: 2,
    STONE: 3,
    WOOD: 4,
    LEAVES: 5,
  });

  /** 면에 그릴 절차적 무늬 종류 (셰이더에서 사용) */
  MBW.Pattern = Object.freeze({
    PLAIN: 0,      // 기본 픽셀 노이즈
    GRASS_SIDE: 1, // 위쪽에 잔디 테두리가 있는 흙
    LEAVES: 2,     // 어두운 점이 섞인 잎
    WOOD_SIDE: 3,  // 세로 줄무늬 나무껍질
    WOOD_TOP: 4,   // 나이테
    STONE: 5,      // 대비가 강한 돌 노이즈
  });

  const B = MBW.BlockType;
  const P = MBW.Pattern;

  /**
   * 블록 정의 객체를 만든다.
   * top/side/bottom 은 각 면의 기본 RGB 색상(0~1)이다.
   */
  function defineBlock(def) {
    return Object.freeze({
      ...def,
      bottom: def.bottom || def.side,
      pattern: Object.freeze(def.pattern),
    });
  }

  const DIRT_COLOR = [0.55, 0.39, 0.25];

  /** 블록 종류별 이름, 색상, 무늬 정의 */
  MBW.BLOCKS = Object.freeze({
    [B.GRASS]: defineBlock({
      id: B.GRASS, name: '잔디', nameEn: 'Grass',
      top: [0.40, 0.70, 0.26], side: DIRT_COLOR, bottom: DIRT_COLOR,
      pattern: { top: P.PLAIN, side: P.GRASS_SIDE, bottom: P.PLAIN },
    }),
    [B.DIRT]: defineBlock({
      id: B.DIRT, name: '흙', nameEn: 'Dirt',
      top: DIRT_COLOR, side: DIRT_COLOR,
      pattern: { top: P.PLAIN, side: P.PLAIN, bottom: P.PLAIN },
    }),
    [B.STONE]: defineBlock({
      id: B.STONE, name: '돌', nameEn: 'Stone',
      top: [0.52, 0.52, 0.54], side: [0.52, 0.52, 0.54],
      pattern: { top: P.STONE, side: P.STONE, bottom: P.STONE },
    }),
    [B.WOOD]: defineBlock({
      id: B.WOOD, name: '나무', nameEn: 'Wood',
      top: [0.72, 0.58, 0.36], side: [0.42, 0.30, 0.18], bottom: [0.72, 0.58, 0.36],
      pattern: { top: P.WOOD_TOP, side: P.WOOD_SIDE, bottom: P.WOOD_TOP },
    }),
    [B.LEAVES]: defineBlock({
      id: B.LEAVES, name: '나뭇잎', nameEn: 'Leaves',
      top: [0.24, 0.55, 0.19], side: [0.24, 0.55, 0.19],
      pattern: { top: P.LEAVES, side: P.LEAVES, bottom: P.LEAVES },
    }),
  });

  /** 핫바에 표시되는 블록 순서 (1~5 키에 대응) */
  MBW.HOTBAR_BLOCKS = Object.freeze([B.GRASS, B.DIRT, B.STONE, B.WOOD, B.LEAVES]);

  /** 블록 ID로 정의를 찾는다. 공기나 잘못된 ID면 null */
  MBW.getBlockDef = function (id) {
    return MBW.BLOCKS[id] || null;
  };

  /** 저장 데이터 검증 등에 쓰는 유효한 블록 ID 판별 (공기 포함) */
  MBW.isValidBlockType = function (id) {
    return Number.isInteger(id) && (id === B.AIR || MBW.BLOCKS[id] !== undefined);
  };
})();
