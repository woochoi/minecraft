/**
 * ui.js
 * ------------------------------------------------------------
 * HTML 기반 UI(시작 화면, HUD, 핫바, 일시정지 메뉴, 알림)를 담당한다.
 * 게임 로직은 모르고, main.js 가 호출하는 표시용 함수와 버튼 콜백만 제공한다.
 */
(function () {
  'use strict';

  const MBW = window.MBW;

  // "월드 초기화" 두 번 클릭 확인 대기 시간(ms)
  const RESET_CONFIRM_MS = 3000;

  class UI {
    constructor() {
      const $ = (id) => document.getElementById(id);
      this.el = {
        canvas: $('game-canvas'),
        hud: $('hud'),
        fps: $('fps'),
        coords: $('coords'),
        targetInfo: $('target-info'),
        lockHint: $('lock-hint'),
        hotbar: $('hotbar'),
        blockName: $('block-name'),
        titleScreen: $('title-screen'),
        startButton: $('start-button'),
        titleMessage: $('title-message'),
        pauseScreen: $('pause-screen'),
        resumeButton: $('resume-button'),
        saveButton: $('save-button'),
        resetButton: $('reset-button'),
        pauseHint: $('pause-hint'),
        toastContainer: $('toast-container'),
      };
      this.slots = [];
      this.resetConfirmTimer = null;
      // 같은 값이면 DOM 을 건드리지 않기 위한 캐시
      this._cache = { fps: '', coords: '', target: '' };
    }

    /**
     * 버튼 콜백 연결
     * @param {{onStart:Function, onResume:Function, onSave:Function, onReset:Function}} callbacks
     */
    bind(callbacks) {
      this.el.startButton.addEventListener('click', () => callbacks.onStart());
      this.el.resumeButton.addEventListener('click', () => callbacks.onResume());
      this.el.saveButton.addEventListener('click', () => callbacks.onSave());
      this.el.resetButton.addEventListener('click', () => {
        // 실수 방지: 3초 안에 한 번 더 눌러야 초기화
        if (this.resetConfirmTimer) {
          this._clearResetConfirm();
          callbacks.onReset();
          return;
        }
        this.el.resetButton.textContent = '정말 초기화할까요? (다시 클릭)';
        this.el.resetButton.classList.add('danger');
        this.resetConfirmTimer = setTimeout(() => this._clearResetConfirm(), RESET_CONFIRM_MS);
      });
    }

    _clearResetConfirm() {
      clearTimeout(this.resetConfirmTimer);
      this.resetConfirmTimer = null;
      this.el.resetButton.textContent = '월드 초기화';
      this.el.resetButton.classList.remove('danger');
    }

    // ---------- 화면 전환 ----------

    showTitle(visible) {
      this.el.titleScreen.classList.toggle('hidden', !visible);
    }

    showHUD(visible) {
      this.el.hud.classList.toggle('hidden', !visible);
    }

    showPause(visible) {
      this.el.pauseScreen.classList.toggle('hidden', !visible);
      if (!visible) {
        this._clearResetConfirm();
        this.setPauseHint('');
      }
    }

    setPauseHint(text) {
      this.el.pauseHint.textContent = text;
    }

    /** 포인터 잠금이 없을 때 "클릭하세요" 안내 표시 */
    showLockHint(visible) {
      this.el.lockHint.classList.toggle('hidden', !visible);
    }

    /** 시작 화면과 일시정지 메뉴에 시드 표시 */
    setSeed(seed) {
      document.querySelectorAll('.seed-label').forEach((el) => { el.textContent = String(seed); });
    }

    /** WebGL 초기화 실패 등 치명적 오류 표시 */
    showFatalError(message) {
      this.el.titleMessage.textContent = message;
      this.el.titleMessage.classList.remove('hidden');
      this.el.startButton.disabled = true;
    }

    // ---------- HUD ----------

    setFPS(fps) {
      const text = 'FPS: ' + Math.round(fps);
      if (text !== this._cache.fps) {
        this._cache.fps = text;
        this.el.fps.textContent = text;
      }
    }

    setCoords(pos) {
      const text = `X: ${pos[0].toFixed(1)}  Y: ${pos[1].toFixed(1)}  Z: ${pos[2].toFixed(1)}`;
      if (text !== this._cache.coords) {
        this._cache.coords = text;
        this.el.coords.textContent = text;
      }
    }

    setTargetInfo(target) {
      let text = '조준: 없음';
      if (target) {
        const def = MBW.getBlockDef(target.blockId);
        text = `조준: ${def ? def.name : '?'} (${target.x}, ${target.y}, ${target.z})`;
      }
      if (text !== this._cache.target) {
        this._cache.target = text;
        this.el.targetInfo.textContent = text;
      }
    }

    // ---------- 핫바 ----------

    /** 블록 ID 목록으로 핫바 칸을 만든다 */
    buildHotbar(blockIds) {
      this.el.hotbar.innerHTML = '';
      this.slots = blockIds.map((id, i) => {
        const def = MBW.getBlockDef(id);
        const slot = document.createElement('div');
        slot.className = 'slot';
        slot.title = `${def.name} (${def.nameEn})`;

        const key = document.createElement('span');
        key.className = 'slot-key';
        key.textContent = String(i + 1);

        const icon = document.createElement('canvas');
        icon.width = 32;
        icon.height = 32;
        this._drawBlockIcon(icon, def);

        slot.append(icon, key);
        this.el.hotbar.appendChild(slot);
        return slot;
      });
    }

    /** 선택 칸 강조와 블록 이름 표시 */
    setSelectedSlot(index, blockId) {
      this.slots.forEach((slot, i) => slot.classList.toggle('selected', i === index));
      const def = MBW.getBlockDef(blockId);
      const nameEl = this.el.blockName;
      nameEl.textContent = def ? `${def.name} · ${def.nameEn}` : '';
      // 애니메이션 재시작 (클래스를 뺐다가 리플로우 후 다시 추가)
      nameEl.classList.remove('pop');
      void nameEl.offsetWidth;
      nameEl.classList.add('pop');
    }

    /**
     * 외부 이미지 없이 2D 캔버스에 등각(isometric) 블록 아이콘을 그린다.
     * 윗면 / 왼쪽 면 / 오른쪽 면을 서로 다른 밝기로 칠해 입체감을 준다.
     */
    _drawBlockIcon(canvas, def) {
      const ctx = canvas.getContext('2d');
      const toCss = (c, shade) =>
        `rgb(${Math.round(c[0] * shade * 255)}, ${Math.round(c[1] * shade * 255)}, ${Math.round(c[2] * shade * 255)})`;

      const top = [[16, 2], [30, 9], [16, 16], [2, 9]];
      const left = [[2, 9], [16, 16], [16, 30], [2, 23]];
      const right = [[16, 16], [30, 9], [30, 23], [16, 30]];

      const fillPoly = (points, color) => {
        ctx.beginPath();
        points.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
        ctx.closePath();
        ctx.fillStyle = color;
        ctx.fill();
      };

      // 면 내부에 픽셀 노이즈를 뿌려 셰이더 무늬와 비슷한 느낌을 낸다
      const random = MBW.createRandom(def.id * 977);
      const speckle = (points, color, shade) => {
        ctx.save();
        ctx.beginPath();
        points.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
        ctx.closePath();
        ctx.clip();
        for (let i = 0; i < 70; i++) {
          const s = shade * (0.82 + random() * 0.3);
          ctx.fillStyle = toCss(color, s);
          ctx.fillRect(Math.floor(random() * 32), Math.floor(random() * 32), 2, 2);
        }
        ctx.restore();
      };

      ctx.clearRect(0, 0, 32, 32);
      fillPoly(top, toCss(def.top, 1.0));
      speckle(top, def.top, 1.0);
      fillPoly(left, toCss(def.side, 0.8));
      speckle(left, def.side, 0.8);
      fillPoly(right, toCss(def.side, 0.62));
      speckle(right, def.side, 0.62);

      // 잔디 블록은 옆면 위쪽에 잔디 띠를 그린다
      if (def.pattern.side === MBW.Pattern.GRASS_SIDE) {
        const grass = MBW.BLOCKS[MBW.BlockType.GRASS].top;
        fillPoly([[2, 9], [16, 16], [16, 20], [2, 13]], toCss(grass, 0.8));
        fillPoly([[16, 16], [30, 9], [30, 13], [16, 20]], toCss(grass, 0.62));
      }

      // 외곽선
      ctx.strokeStyle = 'rgba(0,0,0,0.55)';
      ctx.lineWidth = 1;
      [top, left, right].forEach((poly) => {
        ctx.beginPath();
        poly.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
        ctx.closePath();
        ctx.stroke();
      });
    }

    // ---------- 알림 ----------

    /**
     * 화면 상단에 잠시 메시지를 띄운다.
     * @param {'info'|'success'|'error'} kind
     */
    toast(message, kind = 'info', duration = 2200) {
      const el = document.createElement('div');
      el.className = `toast ${kind}`;
      el.textContent = message;
      this.el.toastContainer.appendChild(el);
      // 너무 많이 쌓이지 않게 오래된 것부터 제거
      while (this.el.toastContainer.children.length > 4) {
        this.el.toastContainer.firstChild.remove();
      }
      setTimeout(() => {
        el.classList.add('leaving');
        setTimeout(() => el.remove(), 300);
      }, duration);
    }
  }

  MBW.UI = UI;
})();
