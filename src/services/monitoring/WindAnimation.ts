// Monitoreo Territorial — Animación de partículas de viento (canvas sobre Mapbox GL).
//
// Diseño deliberadamente simple: esto NO es una simulación físicamente
// exacta, es una máscara decorativa pegada al globo, como pide el producto.
// Reglas de diseño:
//   1) Nunca se limpia ni se pausa el render al mover/rotar/hacer zoom — se
//      sigue dibujando en cada frame, siempre.
//   2) Ocultar partículas en la cara no visible del globo se resuelve con
//      geometría simple y barata.
//   3) La cantidad de partículas y la resolución del campo de viento NO
//      dependen del zoom.

import type mapboxgl from "mapbox-gl";
import { WindFieldService, sampleField, type WindFieldData } from "@/services/monitoring/WindField";

const MAX_PARTICLES = 1400;
const MIN_PARTICLES = 600;
const MAX_AGE = 140;
const STEP_HOURS = 0.035;
const KM_PER_DEG = 111.32;
const MAX_LAT = 84;

const GLOBE_CULL_ZOOM = 6;
const GLOBE_VISIBLE_ANGLE_DEG = 80;

interface Pt {
  x: number;
  y: number;
}

export class WindAnimation {
  private map: mapboxgl.Map;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private raf = 0;
  private running = false;
  private dpr = 1;

  private plng = new Float64Array(0);
  private plat = new Float64Array(0);

  private lx = new Float32Array(0);
  private ly = new Float32Array(0);

  private age = new Float32Array(0);
  private count = 0;

  private field: WindFieldData | null = null;
  private hourOffset = 0;
  private sample = { u: 0, v: 0 };

  constructor(map: mapboxgl.Map) {
    this.map = map;

    this.canvas = document.createElement("canvas");
    this.canvas.style.position = "absolute";
    this.canvas.style.inset = "0";
    this.canvas.style.pointerEvents = "none";
    this.canvas.style.zIndex = "5";

    this.ctx = this.canvas.getContext("2d", { alpha: true })!;

    map.getContainer().appendChild(this.canvas);

    this.resize();

    this.onResize = this.onResize.bind(this);

    window.addEventListener("resize", this.onResize);
    map.on("resize", this.onResize);
  }

  setGrid(_grid?: unknown) {
    void this.ensureField();
  }

  setHourOffset(h: number) {
    this.hourOffset = h;
  }

  async start() {
    if (this.running) return;

    this.running = true;

    this.seedAll();
    this.loop();

    await this.ensureField();

    this.seedAll();
  }

  stop() {
    this.running = false;

    if (this.raf) {
      cancelAnimationFrame(this.raf);
    }

    this.raf = 0;

    this.clear();
  }

  destroy() {
    this.stop();

    window.removeEventListener("resize", this.onResize);
    this.map.off("resize", this.onResize);

    this.canvas.remove();
  }

  private async ensureField() {
    if (this.field) return this.field;

    try {
      this.field = await WindFieldService.load();
    } catch (err) {
      console.warn("[wind] no se pudo cargar el campo global", err);
    }

    return this.field;
  }

  private onResize() {
    this.resize();
    this.adjustCount();
  }

  private clear() {
    const { width, height } = this.canvas;

    this.ctx.save();

    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.clearRect(0, 0, width, height);

    this.ctx.restore();
  }

  private resize() {
    const c = this.map.getContainer();

    this.dpr = Math.min(2, window.devicePixelRatio || 1);

    this.canvas.width = Math.max(1, c.clientWidth * this.dpr);
    this.canvas.height = Math.max(1, c.clientHeight * this.dpr);

    this.canvas.style.width = c.clientWidth + "px";
    this.canvas.style.height = c.clientHeight + "px";

    this.ctx.setTransform(
      this.dpr,
      0,
      0,
      this.dpr,
      0,
      0
    );

    this.ctx.lineCap = "round";
  }

  private targetCount() {
    const w = this.canvas.width / this.dpr;
    const h = this.canvas.height / this.dpr;

    return Math.round(
      Math.max(
        MIN_PARTICLES,
        Math.min(MAX_PARTICLES, (w * h) / 620)
      )
    );
  }

  private project(lng: number, lat: number): Pt {
    const p = this.map.project([lng, lat] as [number, number]);

    return {
      x: p.x,
      y: p.y,
    };
  }

  private unproject(x: number, y: number) {
    const ll = this.map.unproject([x, y] as [number, number]);

    return {
      lng: ll.lng,
      lat: ll.lat,
    };
  }

  private greatCircleDeg(
    lat1: number,
    lon1: number,
    lat2: number,
    lon2: number
  ): number {
    const toRad = Math.PI / 180;

    const p1 = lat1 * toRad;
    const p2 = lat2 * toRad;

    const dp = (lat2 - lat1) * toRad;
    const dl = (lon2 - lon1) * toRad;

    const a =
      Math.sin(dp / 2) ** 2 +
      Math.cos(p1) *
        Math.cos(p2) *
        Math.sin(dl / 2) ** 2;

    return (
      2 *
      Math.atan2(
        Math.sqrt(a),
        Math.sqrt(Math.max(0, 1 - a))
      ) *
      (180 / Math.PI)
    );
  }

  private isOnVisibleHemisphere(
    lng: number,
    lat: number
  ): boolean {
    if (this.map.getZoom() >= GLOBE_CULL_ZOOM) {
      return true;
    }

    const c = this.map.getCenter();

    return (
      this.greatCircleDeg(
        c.lat,
        c.lng,
        lat,
        lng
      ) < GLOBE_VISIBLE_ANGLE_DEG
    );
  }

  private onCanvas(
    p: Pt,
    w: number,
    h: number
  ): boolean {
    return (
      Number.isFinite(p.x) &&
      Number.isFinite(p.y) &&
      p.x > -20 &&
      p.x < w + 20 &&
      p.y > -20 &&
      p.y < h + 20
    );
  }

  private randomVisiblePoint(
    w: number,
    h: number
  ): {
    lng: number;
    lat: number;
    p: Pt;
  } | null {
    for (let attempt = 0; attempt < 8; attempt++) {
      const x = Math.random() * w;
      const y = Math.random() * h;

      const ll = this.unproject(x, y);

      if (
        !Number.isFinite(ll.lat) ||
        Math.abs(ll.lat) > MAX_LAT
      ) {
        continue;
      }

      if (
        !this.isOnVisibleHemisphere(
          ll.lng,
          ll.lat
        )
      ) {
        continue;
      }

      return {
        lng: ll.lng,
        lat: ll.lat,
        p: {
          x,
          y,
        },
      };
    }

    return null;
  }

  private respawn(
    i: number,
    w: number,
    h: number,
    randomAge = false
  ) {
    const pt = this.randomVisiblePoint(w, h);

    if (pt) {
      this.plng[i] = pt.lng;
      this.plat[i] = pt.lat;

      this.lx[i] = pt.p.x;
      this.ly[i] = pt.p.y;
    } else {
      const c = this.map.getCenter();

      const lng =
        c.lng +
        (Math.random() - 0.5) * 2;

      const lat = Math.max(
        -MAX_LAT,
        Math.min(
          MAX_LAT,
          c.lat +
            (Math.random() - 0.5) * 2
        )
      );

      const p = this.project(lng, lat);

      this.plng[i] = lng;
      this.plat[i] = lat;

      this.lx[i] = p.x;
      this.ly[i] = p.y;
    }

    this.age[i] = randomAge
      ? Math.random() * MAX_AGE
      : 0;
  }

  private allocate(target: number) {
    const plng = new Float64Array(target);
    const plat = new Float64Array(target);

    const lx = new Float32Array(target);
    const ly = new Float32Array(target);

    const age = new Float32Array(target);

    const keep = Math.min(
      target,
      this.count
    );

    plng.set(
      this.plng.subarray(0, keep)
    );

    plat.set(
      this.plat.subarray(0, keep)
    );

    lx.set(
      this.lx.subarray(0, keep)
    );

    ly.set(
      this.ly.subarray(0, keep)
    );

    age.set(
      this.age.subarray(0, keep)
    );

    const prevCount = this.count;

    this.plng = plng;
    this.plat = plat;
    this.lx = lx;
    this.ly = ly;
    this.age = age;

    this.count = target;

    return prevCount;
  }

  private adjustCount() {
    const target = this.targetCount();

    if (target === this.count) {
      return;
    }

    const prevCount = this.allocate(target);

    if (target > prevCount) {
      const w =
        this.canvas.width / this.dpr;

      const h =
        this.canvas.height / this.dpr;

      for (
        let i = prevCount;
        i < target;
        i++
      ) {
        this.respawn(
          i,
          w,
          h,
          true
        );
      }
    }
  }

  private seedAll() {
    this.count = 0;

    this.allocate(
      this.targetCount()
    );

    const w =
      this.canvas.width / this.dpr;

    const h =
      this.canvas.height / this.dpr;

    for (
      let i = 0;
      i < this.count;
      i++
    ) {
      this.respawn(
        i,
        w,
        h,
        true
      );
    }
  }

  private loop = () => {
    if (!this.running) {
      return;
    }

    this.raf =
      requestAnimationFrame(
        this.loop
      );

    if (!this.field || !this.count) {
      return;
    }

    const ctx = this.ctx;

    const w =
      this.canvas.width / this.dpr;

    const h =
      this.canvas.height / this.dpr;

    // Fade de las estelas.
    ctx.globalCompositeOperation =
      "destination-in";

    ctx.fillStyle =
      "rgba(0,0,0,0.90)";

    ctx.fillRect(
      0,
      0,
      w,
      h
    );

    ctx.globalCompositeOperation =
      "source-over";

    for (
      let i = 0;
      i < this.count;
      i++
    ) {
      this.age[i] += 1;

      if (
        this.age[i] > MAX_AGE
      ) {
        this.respawn(
          i,
          w,
          h
        );

        continue;
      }

      const lng = this.plng[i];
      const lat = this.plat[i];

      if (
        !sampleField(
          this.field,
          lng,
          lat,
          this.hourOffset,
          this.sample
        )
      ) {
        this.respawn(
          i,
          w,
          h
        );

        continue;
      }

      const cosLat = Math.max(
        0.15,
        Math.cos(
          (lat * Math.PI) / 180
        )
      );

      const dLat =
        (this.sample.v *
          STEP_HOURS) /
        KM_PER_DEG;

      const dLon =
        (this.sample.u *
          STEP_HOURS) /
        (KM_PER_DEG * cosLat);

      let newLat =
        lat + dLat;

      let newLng =
        lng + dLon;

      newLat = Math.max(
        -MAX_LAT,
        Math.min(
          MAX_LAT,
          newLat
        )
      );

      newLng =
        ((newLng + 180) % 360 + 360) %
          360 -
        180;

      const p = this.project(
        newLng,
        newLat
      );

      if (
        !this.onCanvas(
          p,
          w,
          h
        ) ||
        !this.isOnVisibleHemisphere(
          newLng,
          newLat
        )
      ) {
        this.respawn(
          i,
          w,
          h
        );

        continue;
      }

      const mag = Math.hypot(
        this.sample.u,
        this.sample.v
      );

      const alpha = Math.min(
        0.95,
        0.42 + mag / 70
      );

      ctx.strokeStyle =
        mag > 45
          ? `rgba(255,246,214,${alpha})`
          : `rgba(255,255,255,${alpha})`;

      ctx.lineWidth =
        mag > 45
          ? 2.1
          : 1.5;

      ctx.beginPath();

      ctx.moveTo(
        this.lx[i],
        this.ly[i]
      );

      ctx.lineTo(
        p.x,
        p.y
      );

      ctx.stroke();

      this.plng[i] = newLng;
      this.plat[i] = newLat;

      this.lx[i] = p.x;
      this.ly[i] = p.y;
    }
  };
}
