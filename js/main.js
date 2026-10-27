/**
 * main.js
 * ------------------------------------------------------------
 * 게임 진입점. 각 모듈을 생성·연결하고 게임 상태와 메인 루프를 관리한다.
 *
 *  상태 흐름:  TITLE ──(GAME START)──▶ PLAYING ◀──(계속하기)── PAUSED
 *                                          └──(ESC/포인터 잠금 해제)──▶ PAUSED
 *
 *  메인 루프(requestAnimationFrame):
 *   1) 경과 시간(dt) 계산 → 2) 고정 간격 물리 업데이트(누적기 방식)
 *   3) 레이캐스트로 조준 블록 갱신 → 4) 변경된 청크 메시 갱신 → 5) 렌더링 → 6) HUD 갱신
 */
(function () {
  'use strict';

  const MBW = window.MBW;
  const { CONFIG, BlockType, Physics, Storage, Vec3 } = MBW;

  const State = Object.freeze({ TITLE: 'title', PLAYING: 'playing', PAUSED: 'paused' });

  /** 게임 전체 상태 (개발자 도구에서 MBW.game 으로 확인 가능) */
  const game = {
    state: State.TITLE,
    seed: CONFIG.DEFAULT_SEED,
    world: null,
    renderer: null,
    player: null,
    input: null,
    ui: null,
    target: null,          // 현재 조준 중인 블록 (레이캐스트 결과)
    accumulator: 0,        // 고정 물리 스텝용 시간 누적
    renderAlpha: 1,        // 물리 스텝 사이 보간 비율
    lastTime: 0,
    fpsFrames: 0,
    fpsTime: 0,
    hudTime: 0,
    heldAction: null,      // 마우스를 누르고 있을 때 반복 동작 { button, timer }
    autosaveTimer: null,
  };
  MBW.game = game;

  // =========================================================
  // 초기화
  // =========================================================

  /** URL 의 ?seed=숫자 를 읽어 시드로 사용 (없으면 기본 시드) */
  function readSeedFromUrl() {
    const value = parseInt(new URLSearchParams(window.location.search).get('seed'), 10);
    return Number.isFinite(value) ? value >>> 0 : CONFIG.DEFAULT_SEED;
  }

  function init() {
    const ui = (game.ui = new MBW.UI());
    game.seed = readSeedFromUrl();
    ui.setSeed(game.seed);

    // 1) 월드 생성 후 저장된 변경분 적용
    game.world = new MBW.World(game.seed);
    game.world.generate();
    loadSavedWorld();

    // 2) WebGL 렌더러 준비 (실패하면 안내 후 중단)
    game.renderer = new MBW.Renderer(ui.el.canvas);
    try {
      game.renderer.init();
      game.renderer.rebuildAll(game.world);
    } catch (e) {
      console.error(e);
      ui.showFatalError('WebGL 초기화에 실패했습니다. 최신 Chrome 에서 하드웨어 가속을 켠 뒤 다시 시도해 주세요. (' + e.message + ')');
      return;
    }

    // 3) 플레이어, 입력, UI 연결
    game.player = new MBW.Player();
    game.player.spawn(game.world);

    game.input = new MBW.Input(ui.el.canvas);
    bindInput();

    ui.buildHotbar(MBW.HOTBAR_BLOCKS);
    ui.setSelectedSlot(game.player.selectedIndex, game.player.getSelectedBlock());
    ui.bind({
      onStart: startGame,
      onResume: resumeGame,
      onSave: () => saveWorld(true),
      onReset: resetWorld,
    });

    // 4) 블록이 바뀌면 자동 저장 예약, 페이지를 떠날 때 즉시 저장
    game.world.onChange(scheduleAutosave);
    window.addEventListener('pagehide', flushAutosave);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') flushAutosave();
    });

    requestAnimationFrame(frame);
  }

  /** 저장 데이터를 읽어 월드에 반영. 손상 시 기본 월드로 복구 */
  function loadSavedWorld() {
    const result = Storage.load(game.world);
    if (result.status === 'ok') {
      game.world.applyChanges(result.changes);
      if (result.changes.length > 0) {
        game.ui.toast(`저장된 월드를 불러왔습니다 (변경된 블록 ${result.changes.length / 4}개)`, 'success');
      }
    } else if (result.status === 'corrupt') {
      game.world.generate();
      game.ui.toast('저장 데이터가 손상되어 기본 월드로 복구했습니다.', 'error', 4000);
    } else if (result.status === 'unavailable') {
      game.ui.toast('브라우저 저장소를 사용할 수 없어 저장 기능이 꺼집니다.', 'error', 4000);
    }
  }

  // =========================================================
  // 입력 처리
  // =========================================================

  function bindInput() {
    const input = game.input;

    input.on('lockchange', (locked) => {
      game.ui.showLockHint(game.state === State.PLAYING && !locked);
      if (locked) {
        // 일시정지 중 잠금이 다시 걸리면 게임으로 복귀
        if (game.state === State.PAUSED) setPlaying();
      } else if (game.state === State.PLAYING) {
        // ESC 로 잠금이 풀리면 일시정지 메뉴 표시
        pauseGame();
      }
    });

    input.on('lockerror', () => {
      // Chrome 은 ESC 직후 곧바로 다시 잠그는 것을 막는다 → 클릭으로 재시도 안내
      if (game.state === State.PLAYING) game.ui.showLockHint(true);
    });

    input.on('keydown', (code, repeat) => {
      if (game.state === State.PLAYING) {
        // 숫자 1~5: 핫바 선택
        const match = /^Digit([1-9])$/.exec(code);
        if (match && !repeat) selectSlot(Number(match[1]) - 1);
        // 포인터 잠금 없이 플레이 중일 때도 ESC 로 일시정지
        if (code === 'Escape' && !input.locked) pauseGame();
      }
    });

    input.on('mousedown', (button) => {
      if (game.state !== State.PLAYING) return;
      if (button === 0) breakBlock();
      else if (button === 2) placeBlock();
      else return;
      game.heldAction = { button, timer: CONFIG.ACTION_REPEAT_DELAY };
    });

    input.on('wheel', (direction) => {
      if (game.state !== State.PLAYING) return;
      game.player.scrollSlot(direction);
      game.ui.setSelectedSlot(game.player.selectedIndex, game.player.getSelectedBlock());
    });

    // 플레이 중 잠금이 풀린 상태에서 캔버스를 클릭하면 다시 잠금 요청
    game.ui.el.canvas.addEventListener('click', () => {
      if (game.state === State.PLAYING && !input.locked) input.requestLock();
    });
  }

  function selectSlot(index) {
    game.player.selectSlot(index);
    game.ui.setSelectedSlot(game.player.selectedIndex, game.player.getSelectedBlock());
  }

  // =========================================================
  // 게임 상태 전환
  // =========================================================

  function startGame() {
    if (game.state !== State.TITLE) return;
    game.ui.showTitle(false);
    game.ui.showHUD(true);
    game.input.enabled = true;
    setPlaying();
    game.input.requestLock();
  }

  function setPlaying() {
    game.state = State.PLAYING;
    game.accumulator = 0;
    game.input.reset();
    game.ui.showPause(false);
    game.ui.showLockHint(!game.input.locked);
  }

  function pauseGame() {
    if (game.state !== State.PLAYING) return;
    game.state = State.PAUSED;
    game.heldAction = null;
    game.input.reset();
    game.input.exitLock();
    game.ui.showLockHint(false);
    game.ui.showPause(true);
  }

  function resumeGame() {
    if (game.state !== State.PAUSED) return;
    setPlaying();
    game.input.requestLock();
  }

  // =========================================================
  // 블록 조작
  // =========================================================

  /** 현재 카메라(눈 위치, 시선)로 조준 블록을 다시 계산 */
  function updateTarget() {
    const eye = game.player.getEyePosition(game.renderAlpha);
    const dir = game.player.getLookDirection();
    game.target = Physics.raycast(game.world, eye, dir, CONFIG.REACH_DISTANCE);
  }

  /** 좌클릭: 조준 블록 제거 */
  function breakBlock() {
    updateTarget();
    const t = game.target;
    if (!t) return;
    if (t.y < CONFIG.MIN_BREAKABLE_Y) {
      game.ui.toast('맨 아래 바닥층은 부술 수 없습니다.');
      return;
    }
    if (game.world.setBlock(t.x, t.y, t.z, BlockType.AIR)) applyWorldEdit();
  }

  /** 우클릭: 조준 블록의 맞닿은 면 바깥 칸에 선택 블록 설치 */
  function placeBlock() {
    updateTarget();
    const t = game.target;
    if (!t) return;
    const n = t.normal;
    if (n[0] === 0 && n[1] === 0 && n[2] === 0) return; // 블록 내부에서 시작한 광선
    const x = t.x + n[0];
    const y = t.y + n[1];
    const z = t.z + n[2];

    if (!game.world.inBounds(x, y, z)) {
      game.ui.toast('월드 범위 밖에는 설치할 수 없습니다.');
      return;
    }
    if (game.world.getBlock(x, y, z) !== BlockType.AIR) return;
    // 플레이어 몸과 겹치는 위치에는 설치 불가
    if (Physics.boxIntersectsBlock(game.player.getBox(), x, y, z)) return;

    if (game.world.setBlock(x, y, z, game.player.getSelectedBlock())) applyWorldEdit();
  }

  /** 블록 변경 직후: 바뀐 청크만 즉시 다시 만들고 조준 정보 갱신 */
  function applyWorldEdit() {
    game.renderer.updateDirtyChunks(game.world);
    updateTarget();
  }

  /** 마우스 버튼을 누르고 있으면 일정 간격으로 동작 반복 */
  function updateHeldAction(dt) {
    const held = game.heldAction;
    if (!held) return;
    if (!game.input.isButtonDown(held.button)) {
      game.heldAction = null;
      return;
    }
    held.timer -= dt;
    if (held.timer <= 0) {
      held.timer += CONFIG.ACTION_REPEAT_INTERVAL;
      if (held.button === 0) breakBlock();
      else placeBlock();
    }
  }

  // =========================================================
  // 저장 / 초기화
  // =========================================================

  function saveWorld(manual) {
    clearTimeout(game.autosaveTimer);
    game.autosaveTimer = null;
    const result = Storage.save(game.world);
    if (manual) {
      if (result.ok) game.ui.toast(`월드를 저장했습니다 (변경된 블록 ${result.count}개)`, 'success');
      else game.ui.toast('저장 실패: ' + result.error, 'error', 3500);
    }
    return result;
  }

  /** 마지막 변경 후 잠시 뒤 자동 저장 (연속 변경 시 한 번만 저장) */
  function scheduleAutosave() {
    clearTimeout(game.autosaveTimer);
    game.autosaveTimer = setTimeout(() => saveWorld(false), CONFIG.AUTOSAVE_DELAY_MS);
  }

  /** 예약된 자동 저장이 있으면 즉시 실행 (페이지 이탈 시) */
  function flushAutosave() {
    if (game.autosaveTimer) saveWorld(false);
  }

  function resetWorld() {
    clearTimeout(game.autosaveTimer);
    game.autosaveTimer = null;
    Storage.clear(game.seed);
    game.world.generate();
    game.renderer.rebuildAll(game.world);
    game.player.spawn(game.world);
    game.target = null;
    game.ui.toast('월드를 처음 상태로 초기화했습니다.', 'success');
  }

  // =========================================================
  // 메인 루프
  // =========================================================

  function frame(timeMs) {
    requestAnimationFrame(frame);

    const now = timeMs / 1000;
    let dt = game.lastTime ? now - game.lastTime : 0;
    game.lastTime = now;
    // 탭 전환 등으로 시간이 크게 튀면 제한 (순간이동/벽 통과 방지)
    dt = Math.max(0, Math.min(dt, CONFIG.MAX_FRAME_TIME));

    if (game.state === State.PLAYING) {
      updatePlaying(dt);
    } else {
      game.input.consumeMouseDelta(); // 메뉴 중 마우스 이동은 버린다
    }

    game.renderer.updateDirtyChunks(game.world);
    const camera = game.state === State.TITLE ? getTitleCamera(now) : getPlayerCamera();
    game.renderer.render(camera, game.state === State.TITLE ? null : game.target);

    updateHUD(dt);
  }

  /** 플레이 중 업데이트: 시점 → 고정 간격 물리 → 조준 → 반복 동작 */
  function updatePlaying(dt) {
    const { player, input } = game;

    const mouse = input.consumeMouseDelta();
    player.look(mouse.dx, mouse.dy);

    // 고정 간격 물리: 프레임 속도가 달라도 이동/점프 결과가 같도록
    const step = CONFIG.PHYSICS_STEP;
    const intent = input.getMoveIntent();
    game.accumulator += dt;
    let steps = 0;
    while (game.accumulator >= step && steps < CONFIG.MAX_PHYSICS_STEPS) {
      player.update(step, intent, game.world);
      game.accumulator -= step;
      steps++;
    }
    if (steps >= CONFIG.MAX_PHYSICS_STEPS) game.accumulator = 0;
    game.renderAlpha = game.accumulator / step;

    updateTarget();
    updateHeldAction(dt);
  }

  /** 플레이어 1인칭 카메라 */
  function getPlayerCamera() {
    return {
      position: game.player.getEyePosition(game.renderAlpha),
      forward: game.player.getLookDirection(),
    };
  }

  /** 시작 화면 배경: 월드 주위를 천천히 도는 카메라 */
  function getTitleCamera(time) {
    const w = game.world;
    const center = [w.sizeX / 2, CONFIG.TERRAIN_BASE_HEIGHT, w.sizeZ / 2];
    const angle = time * 0.08;
    const radius = Math.max(w.sizeX, w.sizeZ) * 0.95;
    const position = [
      center[0] + Math.cos(angle) * radius,
      center[1] + radius * 0.55,
      center[2] + Math.sin(angle) * radius,
    ];
    return { position, forward: Vec3.normalize(Vec3.subtract(center, position)) };
  }

  /** FPS(0.5초 평균)와 좌표/조준 정보(0.1초 간격) 갱신 */
  function updateHUD(dt) {
    game.fpsFrames++;
    game.fpsTime += dt;
    if (game.fpsTime >= CONFIG.FPS_UPDATE_INTERVAL) {
      game.ui.setFPS(game.fpsFrames / game.fpsTime);
      game.fpsFrames = 0;
      game.fpsTime = 0;
    }

    game.hudTime += dt;
    if (game.state !== State.TITLE && game.hudTime >= CONFIG.HUD_UPDATE_INTERVAL) {
      game.hudTime = 0;
      game.ui.setCoords(game.player.position);
      game.ui.setTargetInfo(game.target);
    }
  }

  // 모든 스크립트가 로드된 뒤(body 끝) 실행된다
  init();
})();
