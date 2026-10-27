/**
 * player.js
 * ------------------------------------------------------------
 * 플레이어 상태(위치, 속도, 시점, 선택 블록)와 이동 규칙을 담당한다.
 * 입력 장치를 직접 읽지 않고 main.js 가 넘겨주는 "이동 의도(intent)"만 사용하며,
 * 렌더링과도 분리되어 카메라 정보(눈 위치, 시선 방향)만 제공한다.
 */
(function () {
  'use strict';

  const MBW = window.MBW;
  const { CONFIG, BlockType, Physics, Vec3 } = MBW;

  class Player {
    constructor() {
      this.position = [0, 0, 0];      // 발 중심 위치
      this.prevPosition = [0, 0, 0];  // 직전 물리 스텝 위치 (렌더 보간용)
      this.velocity = [0, 0, 0];
      this.yaw = 0;                   // 좌우 회전 (0 = -Z 방향)
      this.pitch = 0;                 // 상하 회전
      this.onGround = false;
      this.selectedIndex = 0;         // 핫바 선택 칸
    }

    /** 월드 중앙 근처의 안전한 지면 위에 플레이어를 세운다 */
    spawn(world) {
      const spot = this._findSpawnColumn(world);
      this.position = [spot.x + 0.5, spot.y, spot.z + 0.5];
      this.prevPosition = this.position.slice();
      this.velocity = [0, 0, 0];
      this.yaw = 0;
      this.pitch = -0.2;
      this.onGround = false;
      this.ensureNotStuck(world);
    }

    /** 중앙에서 나선형으로 넓혀 가며 나무가 아닌 지면 기둥을 찾는다 */
    _findSpawnColumn(world) {
      const cx = Math.floor(world.sizeX / 2);
      const cz = Math.floor(world.sizeZ / 2);
      const maxRadius = Math.max(world.sizeX, world.sizeZ);
      for (let r = 0; r <= maxRadius; r++) {
        for (let dz = -r; dz <= r; dz++) {
          for (let dx = -r; dx <= r; dx++) {
            if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue; // 테두리만 검사
            const x = cx + dx;
            const z = cz + dz;
            if (x < 0 || z < 0 || x >= world.sizeX || z >= world.sizeZ) continue;
            const top = world.getTopSolidY(x, z);
            const id = world.getBlock(x, top, z);
            if (id === BlockType.WOOD || id === BlockType.LEAVES) continue;
            if (top + 1 + CONFIG.PLAYER_HEIGHT >= world.sizeY) continue;
            return { x, y: top + 1, z };
          }
        }
      }
      return { x: cx, y: world.sizeY, z: cz };
    }

    /** 블록에 끼어 있으면 빈 공간이 나올 때까지 위로 올린다 */
    ensureNotStuck(world) {
      for (let i = 0; i < world.sizeY + 2; i++) {
        if (!Physics.boxCollidesWorld(world, Physics.getPlayerBox(this.position))) return;
        this.position[1] = Math.floor(this.position[1]) + 1 + 1e-3;
      }
      this.prevPosition = this.position.slice();
    }

    /** 마우스 이동량으로 시점을 회전한다 */
    look(dx, dy) {
      this.yaw -= dx * CONFIG.MOUSE_SENSITIVITY;
      this.pitch -= dy * CONFIG.MOUSE_SENSITIVITY;
      this.pitch = Math.max(-CONFIG.MAX_PITCH, Math.min(CONFIG.MAX_PITCH, this.pitch));
      // yaw 를 -π~π 로 유지 (값이 무한히 커지지 않게)
      if (this.yaw > Math.PI) this.yaw -= Math.PI * 2;
      else if (this.yaw < -Math.PI) this.yaw += Math.PI * 2;
    }

    /**
     * 고정 시간 간격(dt)으로 한 스텝 진행한다.
     * @param {{forward:number, right:number, jump:boolean}} intent 이동 의도 (-1~1)
     */
    update(dt, intent, world) {
      this.prevPosition[0] = this.position[0];
      this.prevPosition[1] = this.position[1];
      this.prevPosition[2] = this.position[2];

      // 1) 시점 기준 수평 이동 방향 계산 (대각선 이동이 빨라지지 않게 정규화)
      let f = intent.forward;
      let r = intent.right;
      const len = Math.hypot(f, r);
      if (len > 1) { f /= len; r /= len; }
      const sin = Math.sin(this.yaw);
      const cos = Math.cos(this.yaw);
      // 전방 = (-sin, -cos), 오른쪽 = (cos, -sin)  (XZ 평면)
      const wishX = (-sin * f + cos * r) * CONFIG.MOVE_SPEED;
      const wishZ = (-cos * f - sin * r) * CONFIG.MOVE_SPEED;

      // 2) 목표 속도로 부드럽게 수렴 (프레임 속도와 무관한 지수 보간)
      const accel = this.onGround ? CONFIG.GROUND_ACCEL : CONFIG.AIR_ACCEL;
      const k = 1 - Math.exp(-accel * dt);
      this.velocity[0] += (wishX - this.velocity[0]) * k;
      this.velocity[2] += (wishZ - this.velocity[2]) * k;

      // 3) 점프: 땅에 서 있을 때만
      if (intent.jump && this.onGround) {
        this.velocity[1] = CONFIG.JUMP_VELOCITY;
        this.onGround = false;
      }

      // 4) 중력 (최대 낙하 속도 제한)
      this.velocity[1] = Math.max(this.velocity[1] - CONFIG.GRAVITY * dt, -CONFIG.MAX_FALL_SPEED);

      // 5) 충돌을 고려해 이동
      const result = Physics.moveAndCollide(world, this.position, this.velocity, dt);
      this.onGround = result.onGround;

      // 안전장치: 월드 아래로 떨어지면 리스폰
      if (this.position[1] < CONFIG.RESPAWN_Y) this.spawn(world);
    }

    /** 렌더링용 눈 위치 (alpha: 직전 스텝과 현재 스텝 사이 보간 비율 0~1) */
    getEyePosition(alpha = 1) {
      const p = this.prevPosition;
      const c = this.position;
      return [
        p[0] + (c[0] - p[0]) * alpha,
        p[1] + (c[1] - p[1]) * alpha + CONFIG.PLAYER_EYE_HEIGHT,
        p[2] + (c[2] - p[2]) * alpha,
      ];
    }

    /** 시선 방향 단위 벡터 */
    getLookDirection() {
      return Vec3.fromYawPitch(this.yaw, this.pitch);
    }

    /** 현재 충돌 박스 */
    getBox() {
      return Physics.getPlayerBox(this.position);
    }

    // ---------- 핫바 선택 ----------

    /** 핫바 칸 직접 선택 */
    selectSlot(index) {
      const count = MBW.HOTBAR_BLOCKS.length;
      if (index >= 0 && index < count) this.selectedIndex = index;
    }

    /** 휠로 선택 칸을 순환 이동 */
    scrollSlot(direction) {
      const count = MBW.HOTBAR_BLOCKS.length;
      this.selectedIndex = (this.selectedIndex + direction + count) % count;
    }

    /** 현재 선택한 블록 ID */
    getSelectedBlock() {
      return MBW.HOTBAR_BLOCKS[this.selectedIndex];
    }
  }

  MBW.Player = Player;
})();
