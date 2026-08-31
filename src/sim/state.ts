/**
 * Fordonstillstånd i struct-of-arrays.
 *
 * Allt ligger i typade arrayer så att steget blir en rak genomgång av minnet
 * istället för hundratusentals objektuppslag. Sorteringen av fordon per körfält
 * görs med en stabil räknesortering på förra stegets ordning följt av en
 * insättningssortering — eftersom fordon knappt byter inbördes ordning mellan två
 * tidssteg blir det linjärt i praktiken.
 */

export const VState = {
  /** Simuleras mikroskopiskt på en länk. */
  Micro: 0,
  /** Ligger i mesomodellens kö på en länk. */
  Meso: 1,
  /** Är inne i en korsning, på en svängrörelse. */
  OnConn: 2,
  /** Väntar på plats för att komma in i nätet. */
  Pending: 3,
} as const;
export type VState = (typeof VState)[keyof typeof VState];

/**
 * Hur många länkar av den planerade rutten som lagras per fordon.
 *
 * Räcker för en resa på ungefär åtta kilometer i ett tätortsnät. Längre resor
 * planeras vidare under färden när slutet av den lagrade delen närmar sig, så
 * fordonet har alltid en färdig väg framför sig utan att hela stadens alla rutter
 * behöver ligga i minnet samtidigt.
 */
export const PATH_SLOT = 96;

export class SimState {
  readonly capacity: number;

  readonly link: Int32Array;
  readonly conn: Int32Array;
  readonly lane: Uint8Array;
  /** Meter längs länkens körbara del, eller längs svängrörelsen. */
  readonly pos: Float32Array;
  readonly speed: Float32Array;
  readonly accel: Float32Array;
  readonly desired: Float32Array;
  readonly length: Float32Array;
  readonly type: Uint8Array;
  /** Förarklass för ruttval — ger spridning i vägval. */
  readonly driver: Uint8Array;
  readonly state: Uint8Array;

  /** Zonen resan startade i — behövs för att kunna visa varifrån bilen kom. */
  readonly originZone: Int32Array;
  readonly destZone: Int32Array;
  readonly destLink: Int32Array;
  /** Planerad svängrörelse ut ur nuvarande länk, -1 = inte vald än. */
  readonly nextConn: Int32Array;
  /** Nästa länk enligt rutten. Styr vilka körfält som är godtagbara. */
  readonly wantLink: Int32Array;
  /**
   * Den planerade rutten: en följd av länkar från nuvarande läge mot målet.
   *
   * Varje fordon äger en fast plats i poolen, så ingen allokering behövs under
   * körning. Att rutten är planerad i förväg är också det som gör att fordon inte
   * kan hamna i rundgång — en väg som följs länk för länk ur ett träd som räknas
   * om under färden kan skicka samma bil fram och tillbaka i all evighet.
   */
  readonly pathPool: Int32Array;
  /** Antal länkar i den lagrade delen av rutten. */
  readonly pathLen: Uint8Array;
  /** Var i rutten fordonet befinner sig. */
  readonly pathPos: Uint8Array;
  /** Sidoförskjutning under pågående filbyte, meter. Bara för renderingen. */
  readonly lateral: Float32Array;

  /** Sekunder fordonet stått stilla — bryter dödlägen och driver otålighet. */
  readonly waited: Float32Array;
  /** Sekunder stillastående vid stopplikt. */
  readonly dwell: Float32Array;
  /**
   * Fordonet har bestämt sig för att tvinga sig fram ur ett dödläge.
   * Beslutet måste hålla i sig tills korsningen är passerad: väntetiden nollställs
   * så fort fordonet rullar igång, så ett villkor som bara ser på väntetiden
   * skulle slå om till stopp igen efter första tidssteget, och fordonet fastnar
   * i en oändlig start-och-stopp-rörelse framför stopplinjen.
   */
  readonly forcing: Uint8Array;
  /**
   * Hur angeläget fordonet behöver byta fil, 0–1, och åt vilket håll.
   *
   * Grannarna i målfilen läser den: en förare som ser någon som måste in släpper
   * fram. Utan den samverkan stannar sammanflätningen upp helt när det är tätt,
   * eftersom ingen lucka någonsin uppstår av sig själv.
   */
  readonly mergeUrge: Float32Array;
  /** -1 = åt höger, +1 = åt vänster, 0 = inget behov. */
  readonly mergeDir: Int8Array;
  readonly enterTime: Float32Array;
  readonly linkEnterTime: Float32Array;
  /** Ackumulerad fördröjning mot fri hastighet, sekunder. */
  readonly delay: Float32Array;
  readonly distance: Float32Array;
  readonly stops: Uint16Array;
  /** Tidpunkt då ett mesofordon tidigast får lämna länken. */
  readonly mesoExit: Float32Array;
  readonly mesoEnter: Float32Array;

  /** Fordonsindex i hinkordning; behålls mellan steg för stabil sortering. */
  order: Int32Array;
  orderCount = 0;
  /**
   * Om fordonet redan står i `order`. En frigjord plats kan återanvändas av ett
   * nytt fordon innan nästa sortering hunnit rensa den gamla posten — utan den
   * här flaggan hamnar samma index två gånger i ordningen, och fordonet börjar
   * följa efter sig självt med orimlig inbromsning som följd.
   */
  private readonly inOrder: Uint8Array;
  /** CSR-start per hink. Hinkar = alla körfält följt av alla svängrörelser. */
  bucketStart: Int32Array;
  private scratch: Int32Array;
  private counts: Int32Array;

  private free: Int32Array;
  private freeCount: number;
  count = 0;

  constructor(capacity: number, bucketCount: number) {
    this.capacity = capacity;
    const i32 = (): Int32Array => new Int32Array(capacity);
    const f32 = (): Float32Array => new Float32Array(capacity);
    const u8 = (): Uint8Array => new Uint8Array(capacity);

    this.link = i32().fill(-1);
    this.conn = i32().fill(-1);
    this.lane = u8();
    this.pos = f32();
    this.speed = f32();
    this.accel = f32();
    this.desired = f32();
    this.length = f32();
    this.type = u8();
    this.driver = u8();
    // Lediga platser måste börja som Pending — annars räknas hela poolen som fordon.
    this.state = u8().fill(VState.Pending);
    this.originZone = i32().fill(-1);
    this.destZone = i32().fill(-1);
    this.destLink = i32().fill(-1);
    this.nextConn = i32().fill(-1);
    this.wantLink = i32().fill(-1);
    this.pathPool = new Int32Array(capacity * PATH_SLOT);
    this.pathLen = new Uint8Array(capacity);
    this.pathPos = new Uint8Array(capacity);
    this.lateral = f32();
    this.waited = f32();
    this.dwell = f32();
    this.forcing = u8();
    this.mergeUrge = f32();
    this.mergeDir = new Int8Array(capacity);
    this.enterTime = f32();
    this.linkEnterTime = f32();
    this.delay = f32();
    this.distance = f32();
    this.stops = new Uint16Array(capacity);
    this.mesoExit = f32();
    this.mesoEnter = f32();

    this.order = i32();
    this.inOrder = new Uint8Array(capacity);
    this.scratch = i32();
    this.bucketStart = new Int32Array(bucketCount + 1);
    this.counts = new Int32Array(bucketCount + 1);

    this.free = i32();
    this.freeCount = capacity;
    for (let i = 0; i < capacity; i++) this.free[i] = capacity - 1 - i;
  }

  alloc(): number {
    if (this.freeCount === 0) return -1;
    this.count++;
    return this.free[--this.freeCount];
  }

  release(v: number): void {
    this.free[this.freeCount++] = v;
    this.count--;
    this.link[v] = -1;
    this.conn[v] = -1;
    this.nextConn[v] = -1;
    this.wantLink[v] = -1;
    this.forcing[v] = 0;
    this.mergeUrge[v] = 0;
    this.mergeDir[v] = 0;
    this.state[v] = VState.Pending;
  }

  /**
   * Sorterar fordonen i hinkar (körfält och svängrörelser) med fordonet längst
   * fram i varje hink först. `bucketOf` returnerar -1 för fordon som inte ska
   * ingå (mesotrafik och väntande).
   */
  sortBuckets(bucketOf: (v: number) => number): void {
    const counts = this.counts;
    counts.fill(0);

    // Stabil räknesortering på förra ordningen — inbördes ordning inom hinken
    // bevaras, vilket gör den efterföljande sorteringen nästan gratis.
    let n = 0;
    for (let i = 0; i < this.orderCount; i++) {
      const v = this.order[i];
      const b = bucketOf(v);
      if (b < 0) {
        this.inOrder[v] = 0;
        continue;
      }
      this.scratch[n++] = v;
      counts[b + 1]++;
    }
    for (let b = 0; b < counts.length - 1; b++) counts[b + 1] += counts[b];
    this.bucketStart.set(counts);

    const cursor = this.bucketStart.slice(0, this.bucketStart.length);
    for (let i = 0; i < n; i++) {
      const v = this.scratch[i];
      this.order[cursor[bucketOf(v)]++] = v;
    }
    this.orderCount = n;

    // Sortera inom hinken efter position, störst först.
    const pos = this.pos;
    for (let b = 0; b + 1 < this.bucketStart.length; b++) {
      const s = this.bucketStart[b];
      const e = cursor[b];
      for (let i = s + 1; i < e; i++) {
        const v = this.order[i];
        const p = pos[v];
        let j = i - 1;
        while (j >= s && pos[this.order[j]] < p) {
          this.order[j + 1] = this.order[j];
          j--;
        }
        this.order[j + 1] = v;
      }
    }
  }

  /** Lägger till ett nytt fordon sist i ordningen så nästa sortering hittar det. */
  registerNew(v: number): void {
    if (this.inOrder[v] === 1) return;
    if (this.orderCount >= this.capacity) return;
    this.inOrder[v] = 1;
    this.order[this.orderCount++] = v;
  }
}
