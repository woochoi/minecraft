/**
 * physics.js
 * ------------------------------------------------------------
 * 플레이어 충돌 처리와 레이캐스팅을 담당한다.
 *  - AABB(축 정렬 박스) vs 복셀 충돌: 축(Y→X→Z)별로 이동하고 겹치면 밀어낸다
 *  - Voxel DDA(Amanatides & Woo) 레이캐스트: 시선이 지나가는 칸을 순서대로 방문
 */
(function () {
  'use strict';

  const MBW = window.MBW;
  const { CONFIG, BlockType } = MBW;

  // 충돌 해소 후 블록 면과 남겨 두는 아주 작은 틈 (부동소수 오차로 다시 겹치는 것 방지)
  const SKIN = 1e-3;

  const Physics = {
    /** 발 위치(pos) 기준 플레이어 충돌 박스 */
    getPlayerBox(pos) {
      const half = CONFIG.PLAYER_WIDTH / 2;
      return {
        minX: pos[0] - half, maxX: pos[0] + half,
        minY: pos[1], maxY: pos[1] + CONFIG.PLAYER_HEIGHT,
        minZ: pos[2] - half, maxZ: pos[2] + half,
      };
    },

    /** 박스가 (bx, by, bz) 블록 칸과 겹치는지 (면이 닿기만 하면 겹침 아님) */
    boxIntersectsBlock(box, bx, by, bz) {
      return box.minX < bx + 1 && box.maxX > bx &&
        box.minY < by + 1 && box.maxY > by &&
        box.minZ < bz + 1 && box.maxZ > bz;
    },

    /** 박스가 월드의 고체 블록과 하나라도 겹치는지 */
    boxCollidesWorld(world, box) {
      for (let y = Math.floor(box.minY); y <= Math.ceil(box.maxY) - 1; y++) {
        for (let z = Math.floor(box.minZ); z <= Math.ceil(box.maxZ) - 1; z++) {
          for (let x = Math.floor(box.minX); x <= Math.ceil(box.maxX) - 1; x++) {
            if (world.isSolidForPhysics(x, y, z)) return true;
          }
        }
      }
      return false;
    },

    /**
     * 한 축으로만 delta 만큼 이동시키고, 블록과 겹치면 가장 가까운 블록 면에 붙여 멈춘다.
     * @param {number[]} pos 발 위치 (직접 수정됨)
     * @param {number} axis 0=X, 1=Y, 2=Z
     * @returns {boolean} 충돌 여부
     */
    moveAxis(world, pos, axis, delta) {
      if (delta === 0) return false;
      pos[axis] += delta;
      const box = this.getPlayerBox(pos);

      let collided = false;
      let limit = delta > 0 ? Infinity : -Infinity;
      for (let y = Math.floor(box.minY); y <= Math.ceil(box.maxY) - 1; y++) {
        for (let z = Math.floor(box.minZ); z <= Math.ceil(box.maxZ) - 1; z++) {
          for (let x = Math.floor(box.minX); x <= Math.ceil(box.maxX) - 1; x++) {
            if (!world.isSolidForPhysics(x, y, z)) continue;
            collided = true;
            const c = axis === 0 ? x : axis === 1 ? y : z;
            // 양수 방향 이동이면 가장 가까운 블록의 최소면, 음수면 최대면이 한계
            limit = delta > 0 ? Math.min(limit, c) : Math.max(limit, c + 1);
          }
        }
      }
      if (!collided) return false;

      if (axis === 1) {
        pos[1] = delta > 0 ? limit - CONFIG.PLAYER_HEIGHT - SKIN : limit + SKIN;
      } else {
        const half = CONFIG.PLAYER_WIDTH / 2;
        pos[axis] = delta > 0 ? limit - half - SKIN : limit + half + SKIN;
      }
      return true;
    },

    /**
     * 속도(vel)로 dt 동안 이동하며 충돌을 처리한다.
     * Y축을 먼저 처리해 착지 여부를 확정한 뒤 X, Z 순서로 이동한다.
     * 충돌한 축의 속도는 0으로 만든다.
     */
    moveAndCollide(world, pos, vel, dt) {
      const result = { onGround: false, hitCeiling: false, hitWall: false };
      if (this.moveAxis(world, pos, 1, vel[1] * dt)) {
        if (vel[1] < 0) result.onGround = true;
        else result.hitCeiling = true;
        vel[1] = 0;
      }
      if (this.moveAxis(world, pos, 0, vel[0] * dt)) {
        vel[0] = 0;
        result.hitWall = true;
      }
      if (this.moveAxis(world, pos, 2, vel[2] * dt)) {
        vel[2] = 0;
        result.hitWall = true;
      }
      return result;
    },

    /**
     * Voxel DDA 레이캐스트.
     * 광선이 통과하는 격자 칸을 정확한 순서로 하나씩 방문하며 첫 번째 고체 블록을 찾는다.
     * @param {number[]} origin 시작점 (눈 위치)
     * @param {number[]} direction 방향 (정규화되지 않아도 됨)
     * @param {number} maxDistance 최대 거리 (블록)
     * @returns {{x,y,z,blockId,normal:number[],distance}|null}
     *   normal 은 광선이 들어온 면의 바깥 방향 (설치 위치 = 블록 + normal)
     */
    raycast(world, origin, direction, maxDistance) {
      const dir = MBW.Vec3.normalize(direction);
      const [ox, oy, oz] = origin;
      const [dx, dy, dz] = dir;
      if (dx === 0 && dy === 0 && dz === 0) return null;

      // 현재 칸
      let x = Math.floor(ox);
      let y = Math.floor(oy);
      let z = Math.floor(oz);

      // 각 축으로 진행할 방향
      const stepX = Math.sign(dx);
      const stepY = Math.sign(dy);
      const stepZ = Math.sign(dz);

      // 한 칸을 가로지르는 데 필요한 광선 거리
      const tDeltaX = stepX !== 0 ? Math.abs(1 / dx) : Infinity;
      const tDeltaY = stepY !== 0 ? Math.abs(1 / dy) : Infinity;
      const tDeltaZ = stepZ !== 0 ? Math.abs(1 / dz) : Infinity;

      // 다음 격자 경계까지의 광선 거리
      let tMaxX = stepX > 0 ? (x + 1 - ox) / dx : stepX < 0 ? (ox - x) / -dx : Infinity;
      let tMaxY = stepY > 0 ? (y + 1 - oy) / dy : stepY < 0 ? (oy - y) / -dy : Infinity;
      let tMaxZ = stepZ > 0 ? (z + 1 - oz) / dz : stepZ < 0 ? (oz - z) / -dz : Infinity;

      let normal = [0, 0, 0];
      let t = 0;

      while (t <= maxDistance) {
        const id = world.getBlock(x, y, z);
        if (id !== BlockType.AIR) {
          return { x, y, z, blockId: id, normal, distance: t };
        }
        // 가장 가까운 경계를 먼저 넘는다
        if (tMaxX < tMaxY && tMaxX < tMaxZ) {
          x += stepX; t = tMaxX; tMaxX += tDeltaX; normal = [-stepX, 0, 0];
        } else if (tMaxY < tMaxZ) {
          y += stepY; t = tMaxY; tMaxY += tDeltaY; normal = [0, -stepY, 0];
        } else {
          z += stepZ; t = tMaxZ; tMaxZ += tDeltaZ; normal = [0, 0, -stepZ];
        }
      }
      return null;
    },
  };

  MBW.Physics = Physics;
})();
