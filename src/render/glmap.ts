/**
 * WebGL-lagret: vägnät, fordon och signaler.
 *
 * Vägnätet byggs en gång till ett indexerat trianglenät med gerade hörn, och
 * färgläggs sedan per bildruta genom en datatextur med ett värde per länk. Det gör
 * att hela nätet ritas i två anrop oavsett hur många gator staden har, och att
 * färgskalan kan bytas utan att geometrin räknas om.
 *
 * Fordonen ritas instansierat: en fyrkant, en instans per fordon.
 */

import type { Camera } from './camera.ts';
import { VEHICLE_STRIDE, type RenderNetwork } from '../sim/protocol.ts';
import type { MapTheme } from '../ui/theme.ts';

const ROAD_VS = `#version 300 es
precision highp float;
in vec2 a_center;
in vec2 a_miter;
in float a_mid;
in float a_half;
in float a_link;

uniform vec2 u_center;
uniform vec2 u_viewport;
uniform float u_scale;
uniform float u_minHalfPx;
uniform float u_widen;
uniform sampler2D u_metric;
uniform int u_texWidth;

out float v_metric;
/** -1 vid ena vägkanten, +1 vid den andra. Bär kantutjämningen. */
out float v_side;
/** Körbanans halva bredd i bildpunkter, för att kunna tona ut exakt en pixel. */
out float v_halfPx;

void main() {
  // Golvet i bildpunkter gäller körbanans halva bredd, inte varje kant för sig.
  // Räknas det per kant kollapsar en smal gata till noll bredd vid utzoomning.
  // Vägens bredd i bildpunkter. Golvet är högre för breda gator än för smala,
  // så stadens stomme går att läsa även långt utzoomad — annars blir hela nätet
  // ett jämntjockt trassel av hårstreck där ingen väg ser viktigare ut än någon
  // annan. Bredden i meter duger som mått på gatans betydelse.
  float rank = clamp((abs(a_half) - 2.8) / 5.5, 0.0, 1.0);
  float floorPx = u_minHalfPx * (1.0 + rank * 1.7);
  float halfPx = max(abs(a_half) * u_scale, floorPx) + u_widen;
  // De två körriktningarna ritas var för sig och ligger isär i sidled. Långt
  // utzoomat blir mellanrummet bredare än vägarna själva och gatan ser ihålig
  // ut, så förskjutningen tonas bort och körbanorna smälter ihop till en gata.
  float merge = clamp((u_scale - 0.05) / 0.28, 0.0, 1.0);
  float offset = a_mid * merge + sign(a_half) * halfPx / u_scale;

  // Geringen förlängs när två segment möts i skarp vinkel, och blir vinkeln
  // riktigt spetsig sticker hörnet ut som en tagg långt utanför vägen. Att
  // begränsa längden kapar taggen och ger en rundad knyck i stället — samma sak
  // som en ritprogramspenna gör med sitt "miter limit".
  vec2 miter = a_miter;
  float miterLen = length(miter);
  if (miterLen > 2.2) miter *= 2.2 / miterLen;
  vec2 world = a_center + miter * offset;

  v_side = sign(a_half);
  v_halfPx = halfPx;

  vec2 screen = (world - u_center) * u_scale;
  gl_Position = vec4(screen / (u_viewport * 0.5) * vec2(1.0, 1.0), 0.0, 1.0);

  int li = int(a_link + 0.5);
  ivec2 uv = ivec2(li % u_texWidth, li / u_texWidth);
  v_metric = texelFetch(u_metric, uv, 0).r;
}`;

const ROAD_FS = `#version 300 es
precision highp float;
in float v_metric;
in float v_side;
in float v_halfPx;
uniform int u_mode;
uniform vec3 u_flat;
// Trafikteknisk skala: rött = stopp, grönt = fri framkomlighet. Stegen kommer
// från temat — en skala som är läsbar mot svart blir blek mot vitt.
uniform vec3 u_ramp[5];
uniform vec3 u_closed;
uniform float u_opacity;
out vec4 outColor;

vec3 ramp(float t) {
  if (t < 0.25) return mix(u_ramp[0], u_ramp[1], t / 0.25);
  if (t < 0.50) return mix(u_ramp[1], u_ramp[2], (t - 0.25) / 0.25);
  if (t < 0.75) return mix(u_ramp[2], u_ramp[3], (t - 0.50) / 0.25);
  return mix(u_ramp[3], u_ramp[4], min((t - 0.75) / 0.25, 1.0));
}

void main() {
  // Kantutjämning: tona ut mot vägkanten så att polygonen inte trappar sig. Bara
  // den yttersta bildpunkten ska mjukas upp — breds mjukningen ut över hela
  // vägbredden blir smala gator nästan genomskinliga, och kartan ser blek ut i
  // stället för mjuk. På en gata smalare än ett par bildpunkter krymper
  // mjukningen med bredden så att gatan ändå syns.
  float distPx = (1.0 - abs(v_side)) * v_halfPx;
  float feather = min(1.0, v_halfPx * 0.55);
  float alpha = clamp(distPx / max(feather, 0.05), 0.0, 1.0) * u_opacity;

  if (u_mode == 0) {
    outColor = vec4(u_flat, alpha);
    return;
  }
  if (v_metric < -0.5) {
    outColor = vec4(u_closed, alpha);
    return;
  }
  float t = clamp(v_metric, 0.0, 1.0);
  if (u_mode == 2) t = 1.0 - clamp(v_metric / 1.1, 0.0, 1.0); // hög belastning = rött
  if (u_mode == 3) t = 1.0 - t;                                // kö/fördröjning: mer = rött
  outColor = vec4(ramp(t), alpha);
}`;

const VEH_VS = `#version 300 es
precision highp float;
in vec2 a_corner;
in vec2 a_pos;
in float a_heading;
in float a_packed;

uniform vec2 u_center;
uniform vec2 u_viewport;
uniform float u_scale;
uniform float u_minPx;
uniform vec3 u_types[4];
uniform vec3 u_stopped;
uniform vec3 u_meso;

out vec3 v_color;
out vec2 v_corner;

void main() {
  int packed = int(a_packed + 0.5);
  int meso = (packed / 16) % 2;
  int stopped = (packed / 8) % 2;
  int type = packed % 8;

  float len = 4.6;
  float wid = 1.9;
  if (type == 1) { len = 5.8; wid = 2.1; }
  if (type == 2) { len = 12.5; wid = 2.5; }
  if (type == 3) { len = 12.0; wid = 2.5; }

  // Under en viss zoom blir fordonet en prick istället för en bil.
  float halfLenPx = max(len * 0.5 * u_scale, u_minPx);
  float halfWidPx = max(wid * 0.5 * u_scale, u_minPx * 0.62);
  vec2 local = vec2(a_corner.x * halfLenPx, a_corner.y * halfWidPx) / u_scale;

  float c = cos(a_heading);
  float s = sin(a_heading);
  vec2 rotated = vec2(local.x * c - local.y * s, local.x * s + local.y * c);
  vec2 world = a_pos + rotated;

  vec2 screen = (world - u_center) * u_scale;
  gl_Position = vec4(screen / (u_viewport * 0.5), 0.0, 1.0);

  vec3 col = u_types[type];
  if (stopped == 1) col = mix(col, u_stopped, 0.75);
  if (meso == 1) col = mix(col, u_meso, 0.55);
  v_color = col;
  v_corner = a_corner;
}`;

const VEH_FS = `#version 300 es
precision highp float;
in vec3 v_color;
in vec2 v_corner;
out vec4 outColor;
void main() {
  // Rundade hörn ger bilarna form utan att kosta extra geometri.
  float d = max(abs(v_corner.x) - 0.75, 0.0) / 0.25;
  float fade = 1.0 - smoothstep(0.85, 1.0, max(d, abs(v_corner.y)));
  if (fade <= 0.02) discard;
  outColor = vec4(v_color, fade);
}`;

const SIGNAL_VS = `#version 300 es
precision highp float;
in vec2 a_corner;
in vec2 a_pos;
in float a_state;

uniform vec2 u_center;
uniform vec2 u_viewport;
uniform float u_scale;
uniform float u_sizePx;

out vec3 v_color;
out vec2 v_corner;

void main() {
  vec2 world = a_pos + a_corner * (u_sizePx / u_scale);
  vec2 screen = (world - u_center) * u_scale;
  gl_Position = vec4(screen / (u_viewport * 0.5), 0.0, 1.0);
  int st = int(a_state + 0.5);
  vec3 col = vec3(0.90, 0.24, 0.24);           // röd
  if (st == 1) col = vec3(0.95, 0.55, 0.15);   // röd+gul
  if (st == 2) col = vec3(0.24, 0.80, 0.42);   // grön
  if (st == 3) col = vec3(0.96, 0.78, 0.20);   // gul
  v_color = col;
  v_corner = a_corner;
}`;

const SIGNAL_FS = `#version 300 es
precision highp float;
in vec3 v_color;
in vec2 v_corner;
uniform vec3 u_rim;
out vec4 outColor;
void main() {
  float r = length(v_corner);
  if (r > 1.0) discard;
  float edge = 1.0 - smoothstep(0.72, 1.0, r);
  vec3 col = mix(u_rim, v_color, smoothstep(1.0, 0.7, r));
  outColor = vec4(col, edge);
}`;

/** Länkarna sorteras i tre grupper så att smågator kan utelämnas vid låg zoom. */
const LOD_MAJOR = 0;
const LOD_MID = 1;
const LOD_MINOR = 2;

function lodOf(cls: number): number {
  if (cls <= 3) return LOD_MAJOR;      // motorväg .. genomfartsgata
  if (cls <= 5) return LOD_MID;        // uppsamlings- och övrig gata
  return LOD_MINOR;                    // lokalgata, gångfart, angöring
}

export class GlMap {
  private gl: WebGL2RenderingContext;
  private roadProgram: WebGLProgram;
  private vehProgram: WebGLProgram;
  private signalProgram: WebGLProgram;

  private roadVao: WebGLVertexArrayObject;
  /** Startindex per detaljnivå i indexbufferten. */
  private lodStart = [0, 0, 0, 0];

  private metricTex: WebGLTexture;
  private texWidth = 2048;
  private texHeight = 1;

  private vehVao: WebGLVertexArrayObject;
  private vehBuffer: WebGLBuffer;
  private vehCount = 0;

  private sigVao: WebGLVertexArrayObject;
  private sigBuffer: WebGLBuffer;
  private sigCount = 0;
  private theme: MapTheme;
  /** Ligger det en flygbild under? Då ska bakgrunden vara genomskinlig. */
  private backdrop = false;

  constructor(canvas: HTMLCanvasElement, net: RenderNetwork, theme: MapTheme) {
    // Alfakanalen behövs för att kunna lägga en flygbild under vägnätet. Utan
    // den blir "genomskinlig bakgrund" i stället helsvart, och bilden under
    // täcks helt.
    const gl = canvas.getContext('webgl2', { antialias: true, alpha: true });
    if (!gl) throw new Error('WebGL2 stöds inte i den här webbläsaren.');
    this.gl = gl;
    this.theme = theme;

    this.roadProgram = link(gl, ROAD_VS, ROAD_FS);
    this.vehProgram = link(gl, VEH_VS, VEH_FS);
    this.signalProgram = link(gl, SIGNAL_VS, SIGNAL_FS);

    const mesh = buildRoadMesh(net);
    this.lodStart = mesh.lodStart;
    this.roadVao = this.uploadRoads(mesh);

    this.texWidth = Math.min(2048, Math.max(1, net.linkCount));
    this.texHeight = Math.ceil(net.linkCount / this.texWidth);
    this.metricTex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.metricTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, this.texWidth, this.texHeight, 0, gl.RED, gl.FLOAT, null);

    const quad = new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]);
    this.vehVao = gl.createVertexArray()!;
    this.vehBuffer = gl.createBuffer()!;
    this.setupInstanced(this.vehVao, this.vehBuffer, quad, this.vehProgram, [
      { name: 'a_pos', size: 2, offset: 0 },
      { name: 'a_heading', size: 1, offset: 8 },
      { name: 'a_packed', size: 1, offset: 12 },
    ], VEHICLE_STRIDE * 4);

    this.sigVao = gl.createVertexArray()!;
    this.sigBuffer = gl.createBuffer()!;
    this.setupInstanced(this.sigVao, this.sigBuffer, quad, this.signalProgram, [
      { name: 'a_pos', size: 2, offset: 0 },
      { name: 'a_state', size: 1, offset: 8 },
    ], 12);

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  }

  private uploadRoads(mesh: RoadMesh): WebGLVertexArrayObject {
    const gl = this.gl;
    const vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);

    const vbo = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, mesh.vertices, gl.STATIC_DRAW);

    const stride = 7 * 4;
    const attr = (name: string, size: number, offset: number): void => {
      const loc = gl.getAttribLocation(this.roadProgram, name);
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, stride, offset);
    };
    attr('a_center', 2, 0);
    attr('a_miter', 2, 8);
    attr('a_mid', 1, 16);
    attr('a_half', 1, 20);
    attr('a_link', 1, 24);

    const ibo = gl.createBuffer()!;
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.indices, gl.STATIC_DRAW);

    gl.bindVertexArray(null);
    return vao;
  }

  private setupInstanced(
    vao: WebGLVertexArrayObject,
    instanceBuffer: WebGLBuffer,
    quad: Float32Array,
    program: WebGLProgram,
    attrs: { name: string; size: number; offset: number }[],
    stride: number,
  ): void {
    const gl = this.gl;
    gl.bindVertexArray(vao);

    const corners = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, corners);
    gl.bufferData(gl.ARRAY_BUFFER, quad, gl.STATIC_DRAW);
    const cornerLoc = gl.getAttribLocation(program, 'a_corner');
    gl.enableVertexAttribArray(cornerLoc);
    gl.vertexAttribPointer(cornerLoc, 2, gl.FLOAT, false, 0, 0);

    gl.bindBuffer(gl.ARRAY_BUFFER, instanceBuffer);
    for (const a of attrs) {
      const loc = gl.getAttribLocation(program, a.name);
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, a.size, gl.FLOAT, false, stride, a.offset);
      gl.vertexAttribDivisor(loc, 1);
    }
    gl.bindVertexArray(null);
  }

  setTheme(theme: MapTheme): void {
    this.theme = theme;
  }

  /**
   * Med flygbild under ritas ingen egen bakgrund, och vägarna görs något
   * genomskinliga så att bebyggelsen syns igenom. Helt täckande vägar över en
   * flygbild ser ut som klistermärken.
   */
  setBackdrop(on: boolean): void {
    this.backdrop = on;
  }

  updateMetric(values: Float32Array): void {
    const gl = this.gl;
    const padded = new Float32Array(this.texWidth * this.texHeight);
    padded.set(values.subarray(0, padded.length));
    gl.bindTexture(gl.TEXTURE_2D, this.metricTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, this.texWidth, this.texHeight, gl.RED, gl.FLOAT, padded);
  }

  updateVehicles(data: Float32Array, count: number): void {
    const gl = this.gl;
    this.vehCount = count;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vehBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, data.subarray(0, count * VEHICLE_STRIDE), gl.DYNAMIC_DRAW);
  }

  updateSignals(positions: Float32Array, states: Uint8Array): void {
    const gl = this.gl;
    this.sigCount = states.length;
    const data = new Float32Array(this.sigCount * 3);
    for (let i = 0; i < this.sigCount; i++) {
      data[i * 3] = positions[i * 2];
      data[i * 3 + 1] = positions[i * 2 + 1];
      data[i * 3 + 2] = states[i];
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, this.sigBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
  }

  render(cam: Camera, opts: { mode: number; showVehicles: boolean; showSignals: boolean }): void {
    const gl = this.gl;
    const w = Math.round(cam.width * cam.dpr);
    const h = Math.round(cam.height * cam.dpr);
    if (gl.canvas.width !== w || gl.canvas.height !== h) {
      gl.canvas.width = w;
      gl.canvas.height = h;
    }
    gl.viewport(0, 0, w, h);
    const bg = this.theme.background;
    if (this.backdrop) gl.clearColor(0, 0, 0, 0);
    else gl.clearColor(bg[0], bg[1], bg[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT);

    const viewport: [number, number] = [cam.width, cam.height];
    const scale = cam.scale;

    // Hur mycket detalj som är meningsfull vid den här zoomnivån.
    let lodLimit = LOD_MAJOR;
    if (scale > 0.035) lodLimit = LOD_MID;
    if (scale > 0.09) lodLimit = LOD_MINOR;
    const indexEnd = this.lodStart[lodLimit + 1];

    gl.useProgram(this.roadProgram);
    gl.bindVertexArray(this.roadVao);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.metricTex);

    const u = (n: string): WebGLUniformLocation | null => gl.getUniformLocation(this.roadProgram, n);
    gl.uniform2f(u('u_center'), cam.x, cam.y);
    gl.uniform2f(u('u_viewport'), viewport[0], viewport[1]);
    gl.uniform1f(u('u_scale'), scale);
    gl.uniform1i(u('u_metric'), 0);
    gl.uniform1i(u('u_texWidth'), this.texWidth);
    gl.uniform3fv(u('u_ramp'), new Float32Array(this.theme.ramp.flat()));
    gl.uniform1f(u('u_opacity'), this.backdrop ? 0.93 : 1);
    gl.uniform3fv(u('u_closed'), new Float32Array(this.theme.closed));

    // Först en mörk kantlinje, sedan själva körbanan ovanpå.
    gl.uniform1f(u('u_minHalfPx'), 1.1);
    gl.uniform1f(u('u_widen'), 1.4);
    gl.uniform1i(u('u_mode'), 0);
    gl.uniform3fv(u('u_flat'), new Float32Array(this.theme.casing));
    gl.uniform1f(u('u_opacity'), this.backdrop ? 0.75 : 1);
    gl.drawElements(gl.TRIANGLES, indexEnd, gl.UNSIGNED_INT, 0);

    gl.uniform1f(u('u_widen'), 0);
    gl.uniform1i(u('u_mode'), opts.mode);
    gl.drawElements(gl.TRIANGLES, indexEnd, gl.UNSIGNED_INT, 0);

    if (opts.showVehicles && this.vehCount > 0 && scale > 0.012) {
      gl.useProgram(this.vehProgram);
      gl.bindVertexArray(this.vehVao);
      const vu = (n: string): WebGLUniformLocation | null => gl.getUniformLocation(this.vehProgram, n);
      gl.uniform2f(vu('u_center'), cam.x, cam.y);
      gl.uniform2f(vu('u_viewport'), viewport[0], viewport[1]);
      gl.uniform1f(vu('u_scale'), scale);
      gl.uniform1f(vu('u_minPx'), 1.1);
      gl.uniform3fv(vu('u_types'), new Float32Array(this.theme.vehicle.flat()));
      gl.uniform3fv(vu('u_stopped'), new Float32Array(this.theme.vehicleStopped));
      gl.uniform3fv(vu('u_meso'), new Float32Array(this.theme.vehicleMeso));
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.vehCount);
    }

    if (opts.showSignals && this.sigCount > 0 && scale > 0.03) {
      gl.useProgram(this.signalProgram);
      gl.bindVertexArray(this.sigVao);
      const su = (n: string): WebGLUniformLocation | null => gl.getUniformLocation(this.signalProgram, n);
      gl.uniform2f(su('u_center'), cam.x, cam.y);
      gl.uniform2f(su('u_viewport'), viewport[0], viewport[1]);
      gl.uniform1f(su('u_scale'), scale);
      gl.uniform1f(su('u_sizePx'), Math.min(5.5, 2.2 + scale * 14));
      gl.uniform3fv(su('u_rim'), new Float32Array(this.theme.signalRim));
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.sigCount);
    }

    gl.bindVertexArray(null);
  }
}

interface RoadMesh {
  vertices: Float32Array;
  indices: Uint32Array;
  lodStart: number[];
}

/**
 * Bygger vägnätets triangelnät. Varje riktad länk blir en remsa med gerade hörn,
 * förskjuten till sin sida av mittlinjen så att de två körriktningarna syns var
 * för sig — det är där skillnaden mellan morgon- och eftermiddagsrusning sitter.
 */
function buildRoadMesh(net: RenderNetwork): RoadMesh {
  const order: number[] = [];
  for (let lod = 0; lod <= LOD_MINOR; lod++) {
    for (let l = 0; l < net.linkCount; l++) if (lodOf(net.linkClass[l]) === lod) order.push(l);
  }

  let pointTotal = 0;
  for (const l of order) pointTotal += net.linkGeomStart[l + 1] - net.linkGeomStart[l];

  const vertices = new Float32Array(pointTotal * 2 * 7);
  const indices = new Uint32Array(Math.max(1, (pointTotal - order.length) * 6));
  const lodStart = [0, 0, 0, 0];

  let vi = 0;
  let ii = 0;
  let currentLod = 0;

  for (const l of order) {
    const lod = lodOf(net.linkClass[l]);
    while (currentLod < lod) lodStart[++currentLod] = ii;

    const s = net.linkGeomStart[l];
    const e = net.linkGeomStart[l + 1];
    const n = e - s;
    if (n < 2) continue;

    const width = net.linkLanes[l] * net.linkLaneWidth[l];
    const oneway = net.linkReverse[l] < 0;
    // Enkelriktad gata ligger mitt på; dubbelriktad håller sig på sin högra sida.
    // Remsan beskrivs med mittlinje och halv bredd, så shadern kan sätta ett
    // minsta antal bildpunkter utan att flytta gatan från sin sida av vägen.
    const mid = oneway ? 0 : width / 2 + 0.35;
    const half = width / 2;

    const base = vi / 7;
    for (let k = 0; k < n; k++) {
      const px = net.geomX[s + k];
      const py = net.geomY[s + k];

      // Gering: bisektrisen mellan de två angränsande segmentens normaler.
      let dx: number;
      let dy: number;
      if (k === 0) {
        dx = net.geomX[s + 1] - px;
        dy = net.geomY[s + 1] - py;
      } else if (k === n - 1) {
        dx = px - net.geomX[s + k - 1];
        dy = py - net.geomY[s + k - 1];
      } else {
        const ax = px - net.geomX[s + k - 1];
        const ay = py - net.geomY[s + k - 1];
        const bx = net.geomX[s + k + 1] - px;
        const by = net.geomY[s + k + 1] - py;
        const la = Math.hypot(ax, ay) || 1;
        const lb = Math.hypot(bx, by) || 1;
        dx = ax / la + bx / lb;
        dy = ay / la + by / lb;
      }
      const len = Math.hypot(dx, dy) || 1;
      // Högernormal till färdriktningen.
      let nx = dy / len;
      let ny = -dx / len;

      // Kompensera för att geringen kortar av bredden i skarpa hörn.
      let miterScale = 1;
      if (k > 0 && k < n - 1) {
        const ax = px - net.geomX[s + k - 1];
        const ay = py - net.geomY[s + k - 1];
        const la = Math.hypot(ax, ay) || 1;
        const cos = (nx * (ay / la) + ny * (-ax / la));
        miterScale = Math.min(3, 1 / Math.max(0.34, Math.abs(cos)));
      }
      nx *= miterScale;
      ny *= miterScale;

      vertices[vi++] = px;
      vertices[vi++] = py;
      vertices[vi++] = nx;
      vertices[vi++] = ny;
      vertices[vi++] = mid;
      vertices[vi++] = -half;
      vertices[vi++] = l;

      vertices[vi++] = px;
      vertices[vi++] = py;
      vertices[vi++] = nx;
      vertices[vi++] = ny;
      vertices[vi++] = mid;
      vertices[vi++] = half;
      vertices[vi++] = l;
    }

    for (let k = 0; k < n - 1; k++) {
      const a = base + k * 2;
      indices[ii++] = a;
      indices[ii++] = a + 1;
      indices[ii++] = a + 2;
      indices[ii++] = a + 1;
      indices[ii++] = a + 3;
      indices[ii++] = a + 2;
    }
  }
  while (currentLod < LOD_MINOR) lodStart[++currentLod] = ii;
  lodStart[LOD_MINOR + 1] = ii;

  return { vertices: vertices.subarray(0, vi), indices: indices.subarray(0, ii), lodStart };
}

function link(gl: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram {
  const program = gl.createProgram()!;
  gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, vs));
  gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error('Shaderprogram gick inte att länka: ' + gl.getProgramInfoLog(program));
  }
  return program;
}

function compile(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type)!;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    throw new Error('Shaderfel: ' + gl.getShaderInfoLog(shader));
  }
  return shader;
}
