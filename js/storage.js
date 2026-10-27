/**
 * storage.js
 * ------------------------------------------------------------
 * localStorage 를 이용한 월드 저장/불러오기/초기화를 담당한다.
 *
 * 저장 형식 (시드마다 별도 키):
 *   { version, seed, size:[X,Y,Z], savedAt, changes:[x,y,z,type, ...] }
 * 시드로 생성한 원본 지형과 달라진 블록만 저장하므로 데이터가 작다.
 * 데이터가 손상되었거나 형식이 맞지 않으면 삭제 후 기본 월드로 복구한다.
 */
(function () {
  'use strict';

  const MBW = window.MBW;
  const { CONFIG } = MBW;

  const Storage = {
    _available: null,

    /** localStorage 사용 가능 여부 (사생활 보호 모드 등에서 막힐 수 있음) */
    isAvailable() {
      if (this._available !== null) return this._available;
      try {
        const testKey = '__mbw_storage_test__';
        window.localStorage.setItem(testKey, '1');
        window.localStorage.removeItem(testKey);
        this._available = true;
      } catch (e) {
        this._available = false;
      }
      return this._available;
    },

    /** 시드별 저장 키 */
    getKey(seed) {
      return CONFIG.STORAGE_KEY_PREFIX + seed;
    },

    /**
     * 현재 월드의 변경분을 저장한다.
     * @returns {{ok:boolean, count?:number, error?:string}}
     */
    save(world) {
      if (!this.isAvailable()) return { ok: false, error: '브라우저 저장소를 사용할 수 없습니다.' };
      const changes = world.getChanges();
      const data = {
        version: CONFIG.SAVE_VERSION,
        seed: world.seed,
        size: [world.sizeX, world.sizeY, world.sizeZ],
        savedAt: Date.now(),
        changes,
      };
      try {
        window.localStorage.setItem(this.getKey(world.seed), JSON.stringify(data));
        return { ok: true, count: changes.length / 4 };
      } catch (e) {
        const quota = e && (e.name === 'QuotaExceededError' || e.code === 22);
        return { ok: false, error: quota ? '저장 공간이 부족합니다.' : String(e && e.message) };
      }
    },

    /**
     * 저장된 변경분을 읽는다.
     * @returns {{status:'ok'|'empty'|'corrupt'|'unavailable', changes?:number[], error?:string}}
     */
    load(world) {
      if (!this.isAvailable()) return { status: 'unavailable' };
      let raw;
      try {
        raw = window.localStorage.getItem(this.getKey(world.seed));
      } catch (e) {
        return { status: 'unavailable' };
      }
      if (raw === null) return { status: 'empty' };

      try {
        const data = JSON.parse(raw);
        const changes = this._validate(data, world);
        return { status: 'ok', changes, savedAt: data.savedAt };
      } catch (e) {
        // 손상된 데이터는 지워서 다음 실행 때 같은 문제가 반복되지 않게 한다
        console.warn('[Storage] 저장 데이터가 손상되어 삭제합니다:', e.message);
        this.clear(world.seed);
        return { status: 'corrupt', error: e.message };
      }
    },

    /** 저장 데이터 형식을 검사하고 변경분 배열을 반환. 문제가 있으면 예외 */
    _validate(data, world) {
      if (!data || typeof data !== 'object') throw new Error('객체 형식이 아님');
      if (data.version !== CONFIG.SAVE_VERSION) throw new Error('지원하지 않는 버전: ' + data.version);
      if (data.seed !== world.seed) throw new Error('시드 불일치');
      const size = data.size;
      if (!Array.isArray(size) || size[0] !== world.sizeX || size[1] !== world.sizeY || size[2] !== world.sizeZ) {
        throw new Error('월드 크기 불일치');
      }
      const changes = data.changes;
      if (!Array.isArray(changes) || changes.length % 4 !== 0) throw new Error('변경 목록 형식 오류');
      for (let i = 0; i < changes.length; i += 4) {
        const x = changes[i], y = changes[i + 1], z = changes[i + 2], type = changes[i + 3];
        if (![x, y, z].every(Number.isInteger) || !world.inBounds(x, y, z)) {
          throw new Error('잘못된 블록 좌표: ' + [x, y, z].join(','));
        }
        if (!MBW.isValidBlockType(type)) throw new Error('잘못된 블록 종류: ' + type);
      }
      return changes;
    },

    /** 저장 데이터 삭제 */
    clear(seed) {
      try {
        window.localStorage.removeItem(this.getKey(seed));
      } catch (e) {
        /* 저장소를 쓸 수 없으면 지울 것도 없다 */
      }
    },
  };

  MBW.Storage = Storage;
})();
