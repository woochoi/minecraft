/**
 * input.js
 * ------------------------------------------------------------
 * 키보드/마우스 입력과 Pointer Lock API 를 담당한다.
 *  - 눌린 키 상태를 보관하고 이동 의도(intent)로 변환
 *  - 포인터 잠금 중 마우스 이동량을 누적 → 매 프레임 소비
 *  - 클릭/휠/키 이벤트는 등록된 핸들러(on)로 전달
 * 게임 규칙은 모르며, 해석은 main.js 가 담당한다.
 */
(function () {
  'use strict';

  // 한 번의 mousemove 에서 이 값보다 크게 튀는 이동량은 무시 (포인터 잠금 직후 튀는 현상 방지)
  const MAX_MOUSE_DELTA = 300;
  // 휠 누적량이 이 값을 넘을 때마다 한 칸 이동 (트랙패드에서 너무 빨리 넘어가지 않게)
  const WHEEL_STEP = 50;
  // 게임 중 브라우저 기본 동작(스크롤 등)을 막을 키
  const BLOCKED_KEYS = new Set(['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);

  class Input {
    /** @param {HTMLElement} lockTarget 포인터 잠금을 걸 요소 (캔버스) */
    constructor(lockTarget) {
      this.lockTarget = lockTarget;
      this.keys = new Set();          // 현재 눌린 키(code)
      this.buttons = new Set();       // 현재 눌린 마우스 버튼
      this.mouseDX = 0;
      this.mouseDY = 0;
      this.wheelAccum = 0;
      this.locked = false;
      this.enabled = false;           // 게임 중일 때만 키 기본 동작을 막는다
      this.handlers = {};
      this._bindEvents();
    }

    /** 이벤트 핸들러 등록: mousedown, wheel, keydown, lockchange, lockerror */
    on(name, handler) {
      this.handlers[name] = handler;
    }

    _emit(name, ...args) {
      if (this.handlers[name]) this.handlers[name](...args);
    }

    _bindEvents() {
      window.addEventListener('keydown', (e) => {
        if (this.enabled && BLOCKED_KEYS.has(e.code)) e.preventDefault();
        this.keys.add(e.code);
        this._emit('keydown', e.code, e.repeat);
      });
      window.addEventListener('keyup', (e) => {
        this.keys.delete(e.code);
      });
      // 창이 포커스를 잃으면 키가 "눌린 채" 남지 않도록 초기화
      window.addEventListener('blur', () => this.reset());

      document.addEventListener('mousemove', (e) => {
        if (!this.locked) return;
        if (Math.abs(e.movementX) > MAX_MOUSE_DELTA || Math.abs(e.movementY) > MAX_MOUSE_DELTA) return;
        this.mouseDX += e.movementX;
        this.mouseDY += e.movementY;
      });

      document.addEventListener('mousedown', (e) => {
        if (!this.locked) return;
        e.preventDefault();
        this.buttons.add(e.button);
        this._emit('mousedown', e.button);
      });
      document.addEventListener('mouseup', (e) => {
        this.buttons.delete(e.button);
      });

      // 우클릭 메뉴 방지 (캔버스 위 또는 게임 중)
      document.addEventListener('contextmenu', (e) => {
        if (this.locked || e.target === this.lockTarget) e.preventDefault();
      });

      window.addEventListener('wheel', (e) => {
        if (!this.locked) return;
        e.preventDefault();
        // deltaMode 1(줄 단위)은 픽셀로 환산
        const delta = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY;
        this.wheelAccum += delta;
        if (Math.abs(this.wheelAccum) >= WHEEL_STEP) {
          this._emit('wheel', Math.sign(this.wheelAccum));
          this.wheelAccum = 0;
        }
      }, { passive: false });

      document.addEventListener('pointerlockchange', () => {
        this.locked = document.pointerLockElement === this.lockTarget;
        if (!this.locked) this.reset();
        this._emit('lockchange', this.locked);
      });
      document.addEventListener('pointerlockerror', () => {
        this._emit('lockerror');
      });
    }

    /** 포인터 잠금 요청. Chrome 은 Promise 를 반환하므로 거부도 처리한다 */
    requestLock() {
      if (this.locked) return;
      try {
        const result = this.lockTarget.requestPointerLock();
        if (result && typeof result.catch === 'function') {
          result.catch(() => this._emit('lockerror'));
        }
      } catch (e) {
        this._emit('lockerror');
      }
    }

    /** 포인터 잠금 해제 */
    exitLock() {
      if (document.pointerLockElement) document.exitPointerLock();
    }

    /** 키/버튼/마우스 누적값 초기화 */
    reset() {
      this.keys.clear();
      this.buttons.clear();
      this.mouseDX = 0;
      this.mouseDY = 0;
      this.wheelAccum = 0;
    }

    isKeyDown(code) {
      return this.keys.has(code);
    }

    isButtonDown(button) {
      return this.buttons.has(button);
    }

    /** 누적된 마우스 이동량을 꺼내고 0으로 초기화 */
    consumeMouseDelta() {
      const delta = { dx: this.mouseDX, dy: this.mouseDY };
      this.mouseDX = 0;
      this.mouseDY = 0;
      return delta;
    }

    /** 키 상태를 이동 의도로 변환 (WASD + 방향키) */
    getMoveIntent() {
      const k = (code) => (this.keys.has(code) ? 1 : 0);
      return {
        forward: (k('KeyW') || k('ArrowUp')) - (k('KeyS') || k('ArrowDown')),
        right: (k('KeyD') || k('ArrowRight')) - (k('KeyA') || k('ArrowLeft')),
        jump: this.keys.has('Space'),
      };
    }
  }

  window.MBW.Input = Input;
})();
