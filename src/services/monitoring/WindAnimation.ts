// Monitoreo Territorial — Animación de partículas de viento (canvas sobre Mapbox).
// Optimizada: campo global U/V precargado (cobertura mundial desde el primer
// frame), partículas en espacio de pantalla (sin map.project por partícula),
// pocas partículas pero bien visibles, y pausa durante el paneo/zoom.
import type mapboxgl from "mapbox-gl";
import { WindFieldService, sampleField, type WindFieldData } from "@/services/monitoring/WindField";

const MAX_PARTICLES = 2200;
const MIN_PARTICLES = 900;
const MAX_AGE = 110;
const SPEED_FACTOR = 0.035; // horas simuladas por frame (aprox.)

export class WindAnimation {
  private map: mapboxgl.Map;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private raf = 0;
  private running = false;
  private moving = false;
  private dpr = 1;

  // Partículas en coordenadas de pantalla (CSS px)
  private px = new Float32Array(0);
  private py = new Float32Array(0);
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
    this.onMoveStart = this.onMoveStart.bind(this);
    this.onMoveEnd = this.onMoveEnd.bind(this);
    window.addEventListener("resize", this.onResize);
    map.on("resize", this.onResize);
    map.on("movestart", this.onMoveStart);
    map.on("moveend", this.onMoveEnd);
  }

  /** Compatibilidad: el campo ahora es global y se carga solo. */
  setGrid(_grid?: unknown) {
    void this.ensureField();
  }
  setHourOffset(h: number) { this.hourOffset = h; }

  async start() {
    if (this.running) return;
    this.running = true;
    this.seed();
    this.loop();
    await this.ensureField();
    this.seed();
  }

  stop() {
    this.running = false;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.clear();
  }

  destroy() {
    this.stop();
    window.removeEventListener("resize", this.onResize);
    this.map.off("resize", this.onResize);
    this.map.off("movestart", this.onMoveStart);
    this.map.off("moveend", this.onMoveEnd);
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

  private onResize() { this.resize(); this.seed(); }
  private onMoveStart() { this.moving = true; this.clear(); }
  private onMoveEnd() { this.moving = false; this.seed(); }

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
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.ctx.lineCap = "round";
  }

  private seed() {
    const w = this.canvas.width / this.dpr;
    const h = this.canvas.height / this.dpr;
    // Densidad estable: pocas partículas, bien distribuidas por toda la vista.
    const target = Math.round(Math.max(MIN_PARTICLES, Math.min(MAX_PARTICLES, (w * h) / 620)));
    if (target !== this.count) {
      this.px = new Float32Array(target);
      this.py = new Float32Array(target);
      this.age = new Float32Array(target);
      this.count = target;
    }
    for (let i = 0; i < this.count; i++) {
      this.px[i] = Math.random() * w;
      this.py[i] = Math.random() * h;
      this.age[i] = Math.random() * MAX_AGE;
    }
  }

  // ---- Proyección inversa rápida (mercator, sin rotación/pitch) ----
  private viewCache = {
    ok: false, cx: 0, cy: 0, mcx: 0, mcy: 0, worldSize: 1,
  };

  private updateView() {
    const rotated = Math.abs(this.map.getBearing()) > 0.01 || this.map.getPitch() > 0.01;
    const c = this.map.getCenter();
    const worldSize = 512 * Math.pow(2, this.map.getZoom());
    this.viewCache = {
      ok: !rotated,
      cx: (this.canvas.width / this.dpr) / 2,
      cy: (this.canvas.height / this.dpr) / 2,
      mcx: (c.lng + 180) / 360,
      mcy: mercY(c.lat),
      worldSize,
    };
  }

  private screenToLngLat(x: number, y: number, out: { lng: number; lat: number }) {
    const vc = this.viewCache;
    if (vc.ok) {
      const mx = vc.mcx + (x - vc.cx) / vc.worldSize;
      const my = vc.mcy + (y - vc.cy) / vc.worldSize;
      out.lng = mx * 360 - 180;
      out.lat = invMercY(my);
    } else {
      const ll = this.map.unproject([x, y]);
      out.lng = ll.lng;
      out.lat = ll.lat;
    }
  }

  private ll = { lng: 0, lat: 0 };

  private loop = () => {
    if (!this.running) return;
    this.raf = requestAnimationFrame(this.loop);
    if (this.moving || !this.field || !this.count) return;

    const ctx = this.ctx;
    const w = this.canvas.width / this.dpr;
    const h = this.canvas.height / this.dpr;

    // Estela: desvanecido suave.
    ctx.globalCompositeOperation = "destination-in";
    ctx.fillStyle = "rgba(0,0,0,0.90)";
    ctx.fillRect(0, 0, w, h);
    ctx.globalCompositeOperation = "source-over";

    this.updateView();
    const pxPerDeg = this.viewCache.worldSize / 360;

    for (let i = 0; i < this.count; i++) {
      const x = this.px[i], y = this.py[i];
      this.age[i] += 1;

      if (this.age[i] > MAX_AGE || x < -20 || x > w + 20 || y < -20 || y > h + 20) {
        this.px[i] = Math.random() * w;
        this.py[i] = Math.random() * h;
        this.age[i] = 0;
        continue;
      }

      this.screenToLngLat(x, y, this.ll);
      if (!sampleField(this.field, this.ll.lng, this.ll.lat, this.hourOffset, this.sample)) {
        this.age[i] = MAX_AGE + 1;
        continue;
      }

      const cosLat = Math.max(0.15, Math.cos((this.ll.lat * Math.PI) / 180));
      const k = (pxPerDeg / (111 * cosLat)) * SPEED_FACTOR;
      const dx = this.sample.u * k;
      const dy = -this.sample.v * k;

      const nx = x + dx, ny = y + dy;
      const mag = Math.hypot(this.sample.u, this.sample.v);

      // Partículas pocas pero nítidas: grosor y brillo según velocidad.
      const alpha = Math.min(0.95, 0.42 + mag / 70);
      ctx.strokeStyle = mag > 45
        ? `rgba(255,246,214,${alpha})`
        : `rgba(255,255,255,${alpha})`;
      ctx.lineWidth = mag > 45 ? 2.1 : 1.5;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(nx, ny);
      ctx.stroke();

      this.px[i] = nx;
      this.py[i] = ny;
    }
  };
}

function mercY(lat: number) {
  const s = Math.sin((Math.max(-85.05, Math.min(85.05, lat)) * Math.PI) / 180);
  return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
}
function invMercY(my: number) {
  const n = Math.PI * (1 - 2 * my);
  return (180 / Math.PI) * Math.atan(Math.sinh(n));
}
