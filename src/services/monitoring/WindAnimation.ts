// Monitoreo Territorial — Animación de partículas de viento (canvas sobre Mapbox GL).
//
// Diferencia clave con la versión anterior: las partículas viven en
// coordenadas GEOGRÁFICAS (lng/lat), no en píxeles de canvas. Cada frame se
// las hace avanzar unos metros según el campo U/V (en grados reales de
// este/norte) y se usa map.project() — la proyección REAL de Mapbox, que en
// modo 'globe' ya sabe resolver la esfera 3D, el bearing, el pitch y el
// zoom — para decidir dónde cae eso en pantalla.
//
// Eso resuelve los tres síntomas reportados:
//   1) "el viento aparece en el espacio al alejar el globo": antes las
//      partículas se sembraban en píxeles de canvas al azar (incluido el
//      fondo negro fuera del globo) y se les inventaba una lng/lat con una
//      fórmula de mapa plano (Mercator) que no tiene sentido fuera del disco
//      del globo. Ahora cada partícula solo existe si su punto geográfico
//      es realmente visible (ver isVisible), así que nunca se dibuja nada
//      fuera de la esfera.
//   2) "la dirección no es la correcta": antes el desplazamiento se
//      calculaba en píxeles de pantalla asumiendo un mapa plano sin rotar
//      (dx = u*k, dy = -v*k). Eso deja de tener sentido apenas hay
//      curvatura del globo o el punto no está en el centro del mapa (los
//      meridianos convergen, el "norte de pantalla" ya no es el "norte
//      geográfico"). Ahora el viento mueve la partícula en grados reales de
//      latitud/longitud; es Mapbox quien traduce eso a píxeles, así que la
//      dirección es correcta en cualquier punto del globo, con cualquier
//      bearing/pitch/zoom.
//   3) "recalcula todo al moverme": antes cada pan/zoom volvía a sembrar
//      TODAS las partículas en píxeles al azar. Ahora las partículas
//      conservan su lng/lat real; al soltar el mouse (moveend) solo se
//      revalida cada una y se repone la que quedó fuera de vista.
import type mapboxgl from "mapbox-gl";
import { WindFieldService, sampleField, type WindFieldData } from "@/services/monitoring/WindField";

const MAX_PARTICLES = 1600;
const MIN_PARTICLES = 700;
const MAX_AGE = 140;
const STEP_HOURS = 0.035; // "horas simuladas" que avanza el campo por frame (velocidad visual del trazo)
const KM_PER_DEG = 111.32;
const MAX_LAT = 84; // el campo global cubre bbox -78..78; un poco de margen antes de descartar
const VISIBILITY_PX_TOL = 1.5; // tolerancia (px) del test de "sigue visible en pantalla"

interface Pt { x: number; y: number }

export class WindAnimation {
  private map: mapboxgl.Map;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private raf = 0;
  private running = false;
  private moving = false;
  private dpr = 1;

  // Posición geográfica real de cada partícula — es la fuente de verdad.
  private plng = new Float64Array(0);
  private plat = new Float64Array(0);
  // Última posición en pantalla ya proyectada (para trazar la estela del próximo frame).
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
    this.seedAll();
    this.loop();
    await this.ensureField();
    this.seedAll();
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

  private onResize() { this.resize(); this.adjustCount(); }
  private onMoveStart() { this.moving = true; this.clear(); }
  private onMoveEnd() {
    this.moving = false;
    // Ya no se re-siembra todo: se conserva la posición geográfica real de
    // cada partícula y solo se reponen las que quedaron fuera de vista.
    this.resync();
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
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.ctx.lineCap = "round";
  }

  private targetCount() {
    const w = this.canvas.width / this.dpr;
    const h = this.canvas.height / this.dpr;
    return Math.round(Math.max(MIN_PARTICLES, Math.min(MAX_PARTICLES, (w * h) / 620)));
  }

  // -----------------------------------------------------------------------
  // Proyección REAL de Mapbox — respeta globe/mercator, bearing, pitch, zoom.
  // Nada de trigonometría Mercator hecha a mano.
  // -----------------------------------------------------------------------
  private project(lng: number, lat: number): Pt {
    const p = this.map.project([lng, lat] as [number, number]);
    return { x: p.x, y: p.y };
  }
  private unproject(x: number, y: number) {
    const ll = this.map.unproject([x, y] as [number, number]);
    return { lng: ll.lng, lat: ll.lat };
  }

  /** Un punto está "realmente visible" si, al proyectarlo a píxel y volver a
   *  desproyectar ESE MISMO píxel, se obtiene el mismo lng/lat (ida y
   *  vuelta). Si el punto está del otro lado del globo, el píxel que le
   *  tocaría en pantalla en realidad corresponde a OTRO punto (el de la
   *  cara visible más cercana), así que la vuelta no coincide. Así se
   *  detecta "cara oculta del globo" sin necesitar la matriz 3D interna de
   *  Mapbox — solo la API pública project/unproject. */
  private isVisible(p: Pt, w: number, h: number): boolean {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return false;
    if (p.x < -20 || p.x > w + 20 || p.y < -20 || p.y > h + 20) return false;
    const back = this.unproject(p.x, p.y);
    const p2 = this.project(back.lng, back.lat);
    return Math.hypot(p.x - p2.x, p.y - p2.y) < VISIBILITY_PX_TOL;
  }

  /** Busca un punto geográfico válido y visible en la vista actual para
   *  sembrar o reponer una partícula. Se prueba con píxeles al azar del
   *  canvas (así la densidad de partículas sigue lo que el usuario está
   *  mirando, ya sea el globo entero o el zoom de una ciudad) y se valida
   *  con isVisible antes de aceptarlo. */
  private randomVisiblePoint(w: number, h: number): { lng: number; lat: number; p: Pt } | null {
    for (let attempt = 0; attempt < 6; attempt++) {
      const x = Math.random() * w;
      const y = Math.random() * h;
      const ll = this.unproject(x, y);
      if (!Number.isFinite(ll.lat) || Math.abs(ll.lat) > MAX_LAT) continue;
      const p = this.project(ll.lng, ll.lat);
      if (this.isVisible(p, w, h)) return { lng: ll.lng, lat: ll.lat, p };
    }
    return null;
  }

  private respawn(i: number, w: number, h: number, randomAge = false) {
    const pt = this.randomVisiblePoint(w, h);
    if (pt) {
      this.plng[i] = pt.lng; this.plat[i] = pt.lat;
      this.lx[i] = pt.p.x; this.ly[i] = pt.p.y;
    } else {
      // Última salida (vista muy rara/transicional): centro del mapa con jitter.
      const c = this.map.getCenter();
      const lng = c.lng + (Math.random() - 0.5) * 2;
      const lat = Math.max(-MAX_LAT, Math.min(MAX_LAT, c.lat + (Math.random() - 0.5) * 2));
      const p = this.project(lng, lat);
      this.plng[i] = lng; this.plat[i] = lat;
      this.lx[i] = p.x; this.ly[i] = p.y;
    }
    this.age[i] = randomAge ? Math.random() * MAX_AGE : 0;
  }

  private allocate(target: number) {
    const plng = new Float64Array(target);
    const plat = new Float64Array(target);
    const lx = new Float32Array(target);
    const ly = new Float32Array(target);
    const age = new Float32Array(target);
    const keep = Math.min(target, this.count);
    plng.set(this.plng.subarray(0, keep));
    plat.set(this.plat.subarray(0, keep));
    lx.set(this.lx.subarray(0, keep));
    ly.set(this.ly.subarray(0, keep));
    age.set(this.age.subarray(0, keep));
    const prevCount = this.count;
    this.plng = plng; this.plat = plat; this.lx = lx; this.ly = ly; this.age = age;
    this.count = target;
    return prevCount;
  }

  /** Cambia la cantidad de partículas (p. ej. al redimensionar la ventana)
   *  conservando las que ya existían — no reinicia toda la animación. */
  private adjustCount() {
    const target = this.targetCount();
    if (target === this.count) return;
    const prevCount = this.allocate(target);
    if (target > prevCount) {
      const w = this.canvas.width / this.dpr, h = this.canvas.height / this.dpr;
      for (let i = prevCount; i < target; i++) this.respawn(i, w, h, true);
    }
  }

  /** Siembra completa (arranque inicial de la capa). */
  private seedAll() {
    this.count = 0;
    this.allocate(this.targetCount());
    const w = this.canvas.width / this.dpr, h = this.canvas.height / this.dpr;
    for (let i = 0; i < this.count; i++) this.respawn(i, w, h, true);
  }

  /** Tras un pan/zoom/rotate: las partículas que siguen visibles conservan
   *  su lng/lat real (el viento no "salta" ni se reinicia); solo se reponen
   *  las que quedaron fuera de la vista o del otro lado del globo. */
  private resync() {
    const w = this.canvas.width / this.dpr, h = this.canvas.height / this.dpr;
    for (let i = 0; i < this.count; i++) {
      const p = this.project(this.plng[i], this.plat[i]);
      if (this.isVisible(p, w, h)) {
        this.lx[i] = p.x; this.ly[i] = p.y;
      } else {
        this.respawn(i, w, h, true);
      }
    }
  }

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

    for (let i = 0; i < this.count; i++) {
      this.age[i] += 1;
      if (this.age[i] > MAX_AGE) { this.respawn(i, w, h); continue; }

      const lng = this.plng[i], lat = this.plat[i];
      if (!sampleField(this.field, lng, lat, this.hourOffset, this.sample)) {
        this.respawn(i, w, h);
        continue;
      }

      // Avance en GRADOS REALES de este/norte — nunca en píxeles de pantalla.
      const cosLat = Math.max(0.15, Math.cos((lat * Math.PI) / 180));
      const dLat = (this.sample.v * STEP_HOURS) / KM_PER_DEG;
      const dLon = (this.sample.u * STEP_HOURS) / (KM_PER_DEG * cosLat);
      let newLat = lat + dLat;
      let newLng = lng + dLon;
      newLat = Math.max(-MAX_LAT, Math.min(MAX_LAT, newLat));
      newLng = ((newLng + 180) % 360 + 360) % 360 - 180; // wrap [-180,180]

      // Mapbox decide dónde cae eso en pantalla: correcto en globo o mapa
      // plano, con cualquier bearing/pitch/zoom.
      const p = this.project(newLng, newLat);
      if (!this.isVisible(p, w, h)) { this.respawn(i, w, h); continue; }

      const mag = Math.hypot(this.sample.u, this.sample.v);
      const alpha = Math.min(0.95, 0.42 + mag / 70);
      ctx.strokeStyle = mag > 45
        ? `rgba(255,246,214,${alpha})`
        : `rgba(255,255,255,${alpha})`;
      ctx.lineWidth = mag > 45 ? 2.1 : 1.5;
      ctx.beginPath();
      ctx.moveTo(this.lx[i], this.ly[i]);
      ctx.lineTo(p.x, p.y);
      ctx.stroke();

      this.plng[i] = newLng; this.plat[i] = newLat;
      this.lx[i] = p.x; this.ly[i] = p.y;
    }
  };
}
