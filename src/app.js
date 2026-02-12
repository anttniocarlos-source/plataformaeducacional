// src/app.js
// MVP — Plataforma Educacional SaaS White-Label (sem servidor web)
// Node (CommonJS), armazenamento em memória, 1 teste em src/test.js
//
// Entrega do MVP conforme documento:
// - Multi-tenant (escolas isoladas)
// - White-label básico (subdomínio + domínio próprio com token mock)
// - Branding + Localization mínimos
// - Cursos: pipeline mock 2 fases (IA mock): estrutura -> aprovação -> geração completa -> publicação
// - Importação de curso (links externos por aula)
// - Marketplace público mínimo (home/lista/página do curso) via host
// - Compra: Order + Checkout demo + Webhook simulado (idempotente) -> matrícula (Enrollment)
// - Suspender/reativar escola
// - Auditoria mínima (logs) e idempotência de webhook

const crypto = require("crypto");

// -----------------------------
// Utils
// -----------------------------
function nowIso() {
  return new Date().toISOString();
}

function normalizeHost(host) {
  if (!host) return "";
  return String(host).trim().toLowerCase().replace(/\.$/, "");
}

function normalizeDomain(domain) {
  let d = String(domain || "").trim().toLowerCase();
  d = d.replace(/^https?:\/\//, "");
  d = d.split("/")[0];
  d = d.split(":")[0];
  return d.replace(/\.$/, "");
}

function isValidDomainLike(value) {
  const v = normalizeDomain(value);
  if (!v) return false;
  if (v.includes(" ")) return false;
  if (!v.includes(".")) return false;
  if (v.length < 4) return false;
  return true;
}

function generateId(prefix) {
  return `${prefix}_${crypto.randomBytes(8).toString("hex")}`;
}

function randomToken(bytes = 12) {
  return crypto.randomBytes(bytes).toString("hex");
}

function hmacSha256(secret, message) {
  return crypto.createHmac("sha256", String(secret)).update(String(message)).digest("hex");
}

function stableStringify(obj) {
  // stringify estável (ordem de keys) para assinatura previsível
  if (obj === null || typeof obj !== "object") return JSON.stringify(obj);
  if (Array.isArray(obj)) return "[" + obj.map(stableStringify).join(",") + "]";
  const keys = Object.keys(obj).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + stableStringify(obj[k])).join(",") + "}";
}

// -----------------------------
// Platform config
// -----------------------------
const PLATFORM = {
  baseDomain: "platform.local", // {slug}.platform.local
  demoCheckoutBaseUrl: "https://checkout.demo.local",
};

// -----------------------------
// In-memory DB
// -----------------------------
const db = {
  schools: new Map(),        // schoolId -> school
  domains: new Map(),        // domainId -> domainConfig
  branding: new Map(),       // schoolId -> branding
  localization: new Map(),   // schoolId -> localization
  gateway: new Map(),        // schoolId -> gatewayConfig
  courses: new Map(),        // courseId -> course
  orders: new Map(),         // orderId -> order
  payments: new Map(),       // paymentId -> payment
  webhookEvents: new Map(),  // eventId -> webhookEvent (idempotência)
  enrollments: new Map(),    // enrollmentId -> enrollment
  audit: new Map(),          // auditId -> auditEvent
};

// Índices (unicidade / busca)
const domainIndex = {
  byCustomDomain: new Map(), // domain -> domainId
  bySubdomain: new Map(),    // host -> schoolId
};

const courseIndex = {
  bySchool: new Map(),       // schoolId -> Set(courseId)
};

const orderIndex = {
  bySchool: new Map(),       // schoolId -> Set(orderId)
  byBuyer: new Map(),        // `${schoolId}:${buyerEmail}` -> Set(orderId)
  byCourse: new Map(),       // `${schoolId}:${courseId}` -> Set(orderId)
};

const enrollmentIndex = {
  bySchoolBuyerCourse: new Map(), // `${schoolId}:${buyerEmail}:${courseId}` -> enrollmentId
};

// -----------------------------
// Audit
// -----------------------------
function auditLog(schoolId, action, payload) {
  const evt = {
    id: generateId("aud"),
    schoolId: schoolId || null,
    action,
    payload: payload || null,
    createdAt: nowIso(),
  };
  db.audit.set(evt.id, evt);
  return { ...evt };
}

function listAuditBySchool(schoolId) {
  const out = [];
  for (const a of db.audit.values()) {
    if (a.schoolId === schoolId) out.push({ ...a });
  }
  out.sort((x, y) => (x.createdAt < y.createdAt ? -1 : 1));
  return out;
}

// -----------------------------
// Schools (multi-tenant)
// -----------------------------
function createSchool({ name, slug }) {
  const n = String(name || "").trim();
  const s = String(slug || "").trim().toLowerCase();

  if (!n) throw new Error("SCHOOL_NAME_REQUIRED");
  if (!s) throw new Error("SCHOOL_SLUG_REQUIRED");
  if (!/^[a-z0-9-]+$/.test(s)) throw new Error("SCHOOL_SLUG_INVALID");

  for (const existing of db.schools.values()) {
    if (existing.slug === s) throw new Error("SCHOOL_SLUG_ALREADY_EXISTS");
  }

  const school = {
    id: generateId("sch"),
    name: n,
    slug: s,
    status: "ACTIVE", // ACTIVE | SUSPENDED
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };

  db.schools.set(school.id, school);

  // subdomínio padrão (sempre)
  ensureDefaultSubdomainForSchool(school.id);

  // defaults
  if (!db.branding.has(school.id)) {
    db.branding.set(school.id, {
      schoolId: school.id,
      publicName: n,
      primaryColor: "#111111",
      secondaryColor: "#ffffff",
      logoUrl: null,
      faviconUrl: null,
      updatedAt: nowIso(),
    });
  }

  if (!db.localization.has(school.id)) {
    db.localization.set(school.id, {
      schoolId: school.id,
      defaultLanguage: "pt-BR",
      defaultCurrency: "BRL",
      timezone: "America/Sao_Paulo",
      updatedAt: nowIso(),
    });
  }

  // gateway demo por padrão (o MVP exige demo)
  if (!db.gateway.has(school.id)) {
    db.gateway.set(school.id, {
      schoolId: school.id,
      provider: "DEMO",
      mode: "demo", // demo | sandbox | live
      webhookSecret: randomToken(16),
      updatedAt: nowIso(),
    });
  }

  // índices
  if (!courseIndex.bySchool.has(school.id)) courseIndex.bySchool.set(school.id, new Set());
  if (!orderIndex.bySchool.has(school.id)) orderIndex.bySchool.set(school.id, new Set());

  auditLog(school.id, "SCHOOL_CREATED", { name: n, slug: s });
  return { ...school };
}

function listSchools() {
  const out = Array.from(db.schools.values()).map((x) => ({ ...x }));
  out.sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
  return out;
}

function setSchoolStatus({ schoolId, status }) {
  const school = db.schools.get(schoolId);
  if (!school) throw new Error("SCHOOL_NOT_FOUND");
  if (!["ACTIVE", "SUSPENDED"].includes(status)) throw new Error("SCHOOL_STATUS_INVALID");

  school.status = status;
  school.updatedAt = nowIso();

  auditLog(schoolId, "SCHOOL_STATUS_CHANGED", { status });
  return { ...school };
}

function assertSchoolActive(schoolId) {
  const school = db.schools.get(schoolId);
  if (!school) throw new Error("SCHOOL_NOT_FOUND");
  if (school.status !== "ACTIVE") throw new Error("SCHOOL_SUSPENDED");
  return school;
}

// agregados básicos
function getSchoolStats(schoolId) {
  if (!db.schools.has(schoolId)) throw new Error("SCHOOL_NOT_FOUND");
  const courses = courseIndex.bySchool.get(schoolId) || new Set();
  const orders = orderIndex.bySchool.get(schoolId) || new Set();
  return {
    schoolId,
    coursesCount: courses.size,
    ordersCount: orders.size,
  };
}

// -----------------------------
// White-label (domains)
// -----------------------------
function ensureDefaultSubdomainForSchool(schoolId) {
  const school = db.schools.get(schoolId);
  if (!school) throw new Error("SCHOOL_NOT_FOUND");

  const host = normalizeHost(`${school.slug}.${PLATFORM.baseDomain}`);
  const existing = domainIndex.bySubdomain.get(host);
  if (existing && existing !== schoolId) throw new Error("SUBDOMAIN_COLLISION");

  domainIndex.bySubdomain.set(host, schoolId);

  const already = Array.from(db.domains.values()).find(
    (d) => d.type === "subdomain" && d.schoolId === schoolId
  );
  if (already) return { ...already };

  const domainConfig = {
    id: generateId("dom"),
    schoolId,
    type: "subdomain",
    domain: host,
    verified: true,
    verificationToken: null,
    createdAt: nowIso(),
    verifiedAt: nowIso(),
  };

  db.domains.set(domainConfig.id, domainConfig);
  auditLog(schoolId, "DOMAIN_SUBDOMAIN_CREATED", { domain: host });
  return { ...domainConfig };
}

function requestCustomDomain({ schoolId, domain }) {
  assertSchoolActive(schoolId);

  const d = normalizeDomain(domain);
  if (!isValidDomainLike(d)) throw new Error("CUSTOM_DOMAIN_INVALID");
  if (d.endsWith(`.${PLATFORM.baseDomain}`)) throw new Error("CUSTOM_DOMAIN_NOT_ALLOWED");

  const takenId = domainIndex.byCustomDomain.get(d);
  if (takenId) {
    const taken = db.domains.get(takenId);
    if (taken && taken.schoolId !== schoolId) throw new Error("CUSTOM_DOMAIN_ALREADY_IN_USE");
  }

  const existing = Array.from(db.domains.values()).find(
    (x) => x.type === "custom" && x.schoolId === schoolId && x.domain === d
  );

  const token = randomToken(12);

  if (existing) {
    existing.verified = false;
    existing.verificationToken = token;
    existing.verifiedAt = null;
    domainIndex.byCustomDomain.set(d, existing.id);
    auditLog(schoolId, "DOMAIN_CUSTOM_REREQUESTED", { domain: d });
    return { ...existing };
  }

  const cfg = {
    id: generateId("dom"),
    schoolId,
    type: "custom",
    domain: d,
    verified: false,
    verificationToken: token, // mock de DNS TXT/CNAME
    createdAt: nowIso(),
    verifiedAt: null,
  };

  db.domains.set(cfg.id, cfg);
  domainIndex.byCustomDomain.set(d, cfg.id);

  auditLog(schoolId, "DOMAIN_CUSTOM_REQUESTED", { domain: d });
  return { ...cfg };
}

function verifyCustomDomain({ schoolId, domain, token }) {
  assertSchoolActive(schoolId);

  const d = normalizeDomain(domain);
  const domainId = domainIndex.byCustomDomain.get(d);
  if (!domainId) throw new Error("CUSTOM_DOMAIN_NOT_REQUESTED");

  const cfg = db.domains.get(domainId);
  if (!cfg) throw new Error("CUSTOM_DOMAIN_NOT_REQUESTED");
  if (cfg.type !== "custom") throw new Error("CUSTOM_DOMAIN_INVALID_STATE");
  if (cfg.schoolId !== schoolId) throw new Error("CUSTOM_DOMAIN_OWNERSHIP_MISMATCH");

  const provided = String(token || "").trim();
  if (!cfg.verificationToken) throw new Error("CUSTOM_DOMAIN_MISSING_TOKEN");
  if (provided !== cfg.verificationToken) throw new Error("CUSTOM_DOMAIN_TOKEN_INVALID");

  cfg.verified = true;
  cfg.verifiedAt = nowIso();

  auditLog(schoolId, "DOMAIN_CUSTOM_VERIFIED", { domain: d });
  return { ...cfg };
}

function resolveSchoolByHost(host) {
  const h = normalizeHost(host);
  if (!h) return null;

  const customId = domainIndex.byCustomDomain.get(h);
  if (customId) {
    const cfg = db.domains.get(customId);
    if (cfg && cfg.type === "custom" && cfg.verified) {
      const school = db.schools.get(cfg.schoolId);
      return school ? { ...school } : null;
    }
  }

  const schoolId = domainIndex.bySubdomain.get(h);
  if (schoolId) {
    const school = db.schools.get(schoolId);
    return school ? { ...school } : null;
  }

  return null;
}

function listDomainsBySchool(schoolId) {
  if (!db.schools.has(schoolId)) throw new Error("SCHOOL_NOT_FOUND");
  const out = [];
  for (const d of db.domains.values()) {
    if (d.schoolId === schoolId) out.push({ ...d });
  }
  out.sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
  return out;
}

// -----------------------------
// Branding + Localization
// -----------------------------
function getBranding(schoolId) {
  if (!db.schools.has(schoolId)) throw new Error("SCHOOL_NOT_FOUND");
  const b = db.branding.get(schoolId);
  return b ? { ...b } : null;
}

function updateBranding({ schoolId, patch }) {
  assertSchoolActive(schoolId);
  const current = db.branding.get(schoolId);
  const next = {
    ...current,
    ...patch,
    schoolId,
    updatedAt: nowIso(),
  };

  if (typeof next.publicName === "string" && !next.publicName.trim()) {
    throw new Error("BRANDING_PUBLIC_NAME_INVALID");
  }

  db.branding.set(schoolId, next);
  auditLog(schoolId, "BRANDING_UPDATED", { patch });
  return { ...next };
}

function getLocalization(schoolId) {
  if (!db.schools.has(schoolId)) throw new Error("SCHOOL_NOT_FOUND");
  const l = db.localization.get(schoolId);
  return l ? { ...l } : null;
}

function updateLocalization({ schoolId, patch }) {
  assertSchoolActive(schoolId);
  const current = db.localization.get(schoolId);
  const next = {
    ...current,
    ...patch,
    schoolId,
    updatedAt: nowIso(),
  };

  if (typeof next.defaultLanguage !== "string" || !next.defaultLanguage.trim()) {
    throw new Error("LOCALIZATION_LANGUAGE_INVALID");
  }
  if (typeof next.defaultCurrency !== "string" || next.defaultCurrency.trim().length !== 3) {
    throw new Error("LOCALIZATION_CURRENCY_INVALID");
  }
  if (typeof next.timezone !== "string" || !next.timezone.trim()) {
    throw new Error("LOCALIZATION_TIMEZONE_INVALID");
  }

  db.localization.set(schoolId, next);
  auditLog(schoolId, "LOCALIZATION_UPDATED", { patch });
  return { ...next };
}

// -----------------------------
// Gateway (DEMO)
// -----------------------------
function getGatewayConfig(schoolId) {
  if (!db.schools.has(schoolId)) throw new Error("SCHOOL_NOT_FOUND");
  const g = db.gateway.get(schoolId);
  return g ? { ...g } : null;
}

function rotateWebhookSecret(schoolId) {
  assertSchoolActive(schoolId);
  const g = db.gateway.get(schoolId);
  if (!g) throw new Error("GATEWAY_NOT_CONFIGURED");
  g.webhookSecret = randomToken(16);
  g.updatedAt = nowIso();
  auditLog(schoolId, "GATEWAY_WEBHOOK_SECRET_ROTATED", {});
  return { ...g };
}

// -----------------------------
// Courses (pipeline mock + import)
// -----------------------------
// Estados (conforme MVP):
// - DRAFT
// - DRAFTING_STRUCTURE
// - STRUCTURE_APPROVED
// - GENERATING_FULL
// - DRAFT_READY
// - PUBLISHED
//
// Tipos:
// - AI (gera estrutura + gera completo mock)
// - IMPORT (estrutura manual + links)

function addCourseToIndex(course) {
  if (!courseIndex.bySchool.has(course.schoolId)) courseIndex.bySchool.set(course.schoolId, new Set());
  courseIndex.bySchool.get(course.schoolId).add(course.id);
}

function getCourseOrThrow(courseId) {
  const c = db.courses.get(courseId);
  if (!c) throw new Error("COURSE_NOT_FOUND");
  return c;
}

function assertCourseSchoolAccess(schoolId, course) {
  if (course.schoolId !== schoolId) throw new Error("COURSE_ACCESS_DENIED");
}

function createCourseAI({ schoolId, title, description, price, currency, promo }) {
  assertSchoolActive(schoolId);

  const t = String(title || "").trim();
  if (!t) throw new Error("COURSE_TITLE_REQUIRED");

  const loc = db.localization.get(schoolId);
  const cur = String(currency || (loc ? loc.defaultCurrency : "BRL")).trim();

  const course = {
    id: generateId("crs"),
    schoolId,
    type: "AI",
    title: t,
    description: String(description || "").trim(),
    tags: [],
    category: null,

    pricing: normalizePricing({ price, currency: cur, promo }),

    // pipeline
    aiInputs: null,
    structure: null,
    fullContent: null,
    state: "DRAFT",

    createdAt: nowIso(),
    updatedAt: nowIso(),
    publishedAt: null,
  };

  db.courses.set(course.id, course);
  addCourseToIndex(course);

  auditLog(schoolId, "COURSE_CREATED", { courseId: course.id, type: "AI" });
  return { ...course };
}

function createCourseImport({ schoolId, title, description, price, currency, promo }) {
  assertSchoolActive(schoolId);

  const t = String(title || "").trim();
  if (!t) throw new Error("COURSE_TITLE_REQUIRED");

  const loc = db.localization.get(schoolId);
  const cur = String(currency || (loc ? loc.defaultCurrency : "BRL")).trim();

  const course = {
    id: generateId("crs"),
    schoolId,
    type: "IMPORT",
    title: t,
    description: String(description || "").trim(),
    tags: [],
    category: null,

    pricing: normalizePricing({ price, currency: cur, promo }),

    // estrutura manual + links
    structure: null,      // { modules: [{title, lessons:[{title, externalUrl}]}] }
    fullContent: null,    // no import, pode ficar null
    state: "DRAFT",

    createdAt: nowIso(),
    updatedAt: nowIso(),
    publishedAt: null,
  };

  db.courses.set(course.id, course);
  addCourseToIndex(course);

  auditLog(schoolId, "COURSE_CREATED", { courseId: course.id, type: "IMPORT" });
  return { ...course };
}

function normalizePricing({ price, currency, promo }) {
  const p = Number(price);
  if (!Number.isFinite(p) || p <= 0) throw new Error("COURSE_PRICE_INVALID");

  const cur = String(currency || "").trim().toUpperCase();
  if (!cur || cur.length !== 3) throw new Error("COURSE_CURRENCY_INVALID");

  const pricing = {
    price: round2(p),
    currency: cur,
    promo: null, // { type: "PERCENT"|"FIXED", value, untilIso }
  };

  if (promo) {
    const pr = normalizePromo(promo, pricing.price);
    pricing.promo = pr;
  }

  return pricing;
}

function normalizePromo(promo, basePrice) {
  const type = String(promo.type || "").trim().toUpperCase();
  const value = Number(promo.value);
  const untilIso = promo.untilIso ? String(promo.untilIso).trim() : null;

  if (!["PERCENT", "FIXED"].includes(type)) throw new Error("PROMO_TYPE_INVALID");
  if (!Number.isFinite(value) || value <= 0) throw new Error("PROMO_VALUE_INVALID");
  if (!untilIso) throw new Error("PROMO_UNTIL_REQUIRED");

  // valida mínimo: não deixar promo zerar ou negativar
  if (type === "PERCENT" && value >= 100) throw new Error("PROMO_PERCENT_INVALID");
  if (type === "FIXED" && value >= basePrice) throw new Error("PROMO_FIXED_INVALID");

  return { type, value: round2(value), untilIso };
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

function getEffectivePrice(pricing, now = new Date()) {
  if (!pricing.promo) return pricing.price;
  const until = new Date(pricing.promo.untilIso);
  if (!(until instanceof Date) || isNaN(until.getTime())) return pricing.price;
  if (now.getTime() > until.getTime()) return pricing.price;

  if (pricing.promo.type === "PERCENT") {
    return round2(pricing.price * (1 - pricing.promo.value / 100));
  }
  if (pricing.promo.type === "FIXED") {
    return round2(pricing.price - pricing.promo.value);
  }
  return pricing.price;
}

// ---- AI mock pipeline (2 fases)
function aiGenerateStructure({ schoolId, courseId, inputs }) {
  assertSchoolActive(schoolId);

  const course = getCourseOrThrow(courseId);
  assertCourseSchoolAccess(schoolId, course);
  if (course.type !== "AI") throw new Error("COURSE_NOT_AI");
  if (course.state !== "DRAFT") throw new Error("COURSE_INVALID_STATE");

  const normalized = normalizeAiInputs(inputs);

  course.aiInputs = normalized;
  course.state = "DRAFTING_STRUCTURE";
  course.updatedAt = nowIso();

  // MOCK: estrutura simples coerente com inputs
  const modules = mockStructureFromInputs(normalized);
  course.structure = { modules };
  course.state = "DRAFTING_STRUCTURE";
  course.updatedAt = nowIso();

  auditLog(schoolId, "COURSE_STRUCTURE_GENERATED", { courseId });
  return { ...course };
}

function normalizeAiInputs(inputs) {
  const theme = String(inputs?.theme || "").trim();
  const audience = String(inputs?.audience || "").trim();
  const level = String(inputs?.level || "").trim();
  const hours = Number(inputs?.hours);
  const language = String(inputs?.language || "").trim();

  if (!theme) throw new Error("AI_INPUT_THEME_REQUIRED");
  if (!audience) throw new Error("AI_INPUT_AUDIENCE_REQUIRED");
  if (!level) throw new Error("AI_INPUT_LEVEL_REQUIRED");
  if (!Number.isFinite(hours) || hours < 8 || hours > 40) throw new Error("AI_INPUT_HOURS_INVALID");
  if (!language) throw new Error("AI_INPUT_LANGUAGE_REQUIRED");

  return { theme, audience, level, hours, language };
}

function mockStructureFromInputs(inp) {
  // bem simples e previsível (MVP): 3 módulos, 3 aulas cada
  const base = [
    "Fundamentos",
    "Aplicação",
    "Projeto",
  ];

  return base.map((mTitle, i) => {
    const lessons = [
      `${mTitle}: conceitos-chave`,
      `${mTitle}: prática guiada`,
      `${mTitle}: exercício e revisão`,
    ];
    const objectives = [
      `Compreender os pontos centrais de ${mTitle.toLowerCase()}.`,
      `Aplicar ${mTitle.toLowerCase()} em cenários típicos.`,
      `Consolidar com exercício orientado.`,
    ];
    return {
      title: `${mTitle} — ${inp.theme}`,
      objectives,
      lessons: lessons.map((t) => ({ title: t })),
    };
  });
}

function editCourseStructure({ schoolId, courseId, structure }) {
  // No MVP: a escola pode editar títulos e reordenar enquanto estiver em DRAFTING_STRUCTURE
  assertSchoolActive(schoolId);

  const course = getCourseOrThrow(courseId);
  assertCourseSchoolAccess(schoolId, course);

  if (course.state !== "DRAFTING_STRUCTURE") throw new Error("COURSE_STRUCTURE_NOT_EDITABLE");

  if (!structure || !Array.isArray(structure.modules) || structure.modules.length === 0) {
    throw new Error("COURSE_STRUCTURE_INVALID");
  }

  // validações mínimas
  for (const m of structure.modules) {
    if (!String(m.title || "").trim()) throw new Error("COURSE_STRUCTURE_MODULE_TITLE_REQUIRED");
    if (!Array.isArray(m.lessons) || m.lessons.length === 0) throw new Error("COURSE_STRUCTURE_LESSONS_REQUIRED");
    for (const l of m.lessons) {
      if (!String(l.title || "").trim()) throw new Error("COURSE_STRUCTURE_LESSON_TITLE_REQUIRED");
    }
  }

  course.structure = structure;
  course.updatedAt = nowIso();

  auditLog(schoolId, "COURSE_STRUCTURE_EDITED", { courseId });
  return { ...course };
}

function approveCourseStructure({ schoolId, courseId }) {
  // Ao aprovar: trava para IA
  assertSchoolActive(schoolId);

  const course = getCourseOrThrow(courseId);
  assertCourseSchoolAccess(schoolId, course);

  if (course.state !== "DRAFTING_STRUCTURE") throw new Error("COURSE_INVALID_STATE");
  if (!course.structure || !Array.isArray(course.structure.modules) || course.structure.modules.length === 0) {
    throw new Error("COURSE_STRUCTURE_MISSING");
  }

  course.state = "STRUCTURE_APPROVED";
  course.updatedAt = nowIso();

  auditLog(schoolId, "COURSE_STRUCTURE_APPROVED", { courseId });
  return { ...course };
}

function aiGenerateFullCourse({ schoolId, courseId }) {
  // Gera uma única vez: conteúdo, quizzes, roteiros, slides, ebook placeholder
  assertSchoolActive(schoolId);

  const course = getCourseOrThrow(courseId);
  assertCourseSchoolAccess(schoolId, course);

  if (course.type !== "AI") throw new Error("COURSE_NOT_AI");
  if (course.state !== "STRUCTURE_APPROVED") throw new Error("COURSE_INVALID_STATE");

  course.state = "GENERATING_FULL";
  course.updatedAt = nowIso();

  const full = mockFullContent(course);
  course.fullContent = full;

  course.state = "DRAFT_READY";
  course.updatedAt = nowIso();

  auditLog(schoolId, "COURSE_FULL_GENERATED", { courseId });
  return { ...course };
}

function mockFullContent(course) {
  const modules = course.structure.modules.map((m, mi) => {
    const lessons = m.lessons.map((l, li) => {
      const title = l.title;
      return {
        title,
        body: `Texto (mock) da aula "${title}". Conteúdo estruturado para leitura e estudo.`,
        videoScript: `Roteiro (mock) para "${title}": abertura, desenvolvimento, exemplo prático e fechamento.`,
        slides: [
          `Slide 1: Introdução a "${title}"`,
          `Slide 2: Conceitos centrais`,
          `Slide 3: Exemplo prático`,
          `Slide 4: Resumo e próximos passos`,
        ],
      };
    });

    const quiz = {
      title: `Quiz do módulo ${mi + 1}`,
      questions: [
        { q: `Pergunta 1 sobre ${m.title}`, options: ["A", "B", "C", "D"], answer: "A" },
        { q: `Pergunta 2 sobre ${m.title}`, options: ["A", "B", "C", "D"], answer: "B" },
      ],
    };

    return {
      title: m.title,
      objectives: m.objectives || [],
      lessons,
      quiz,
    };
  });

  return {
    generatedAt: nowIso(),
    modules,
    artifacts: {
      ebook: {
        type: "JSON_PLACEHOLDER",
        title: `Ebook (mock) — ${course.title}`,
        chapters: modules.map((m) => m.title),
      },
      materials: {
        type: "JSON_PLACEHOLDER",
        items: ["Checklist (mock)", "Resumo (mock)", "Guia rápido (mock)"],
      },
    },
  };
}

// ---- Import pipeline (estrutura manual + links)
function setImportStructure({ schoolId, courseId, structure }) {
  assertSchoolActive(schoolId);

  const course = getCourseOrThrow(courseId);
  assertCourseSchoolAccess(schoolId, course);
  if (course.type !== "IMPORT") throw new Error("COURSE_NOT_IMPORT");
  if (!["DRAFT"].includes(course.state)) throw new Error("COURSE_INVALID_STATE");

  validateImportStructure(structure);

  course.structure = structure;
  course.state = "DRAFT_READY"; // import não precisa geração; fica pronto para publicar
  course.updatedAt = nowIso();

  auditLog(schoolId, "COURSE_IMPORT_STRUCTURE_SET", { courseId });
  return { ...course };
}

function validateImportStructure(structure) {
  if (!structure || !Array.isArray(structure.modules) || structure.modules.length === 0) {
    throw new Error("COURSE_STRUCTURE_INVALID");
  }
  for (const m of structure.modules) {
    if (!String(m.title || "").trim()) throw new Error("COURSE_STRUCTURE_MODULE_TITLE_REQUIRED");
    if (!Array.isArray(m.lessons) || m.lessons.length === 0) throw new Error("COURSE_STRUCTURE_LESSONS_REQUIRED");
    for (const l of m.lessons) {
      if (!String(l.title || "").trim()) throw new Error("COURSE_STRUCTURE_LESSON_TITLE_REQUIRED");
      const url = String(l.externalUrl || "").trim();
      if (!url) throw new Error("COURSE_IMPORT_URL_REQUIRED");
    }
  }
}

function publishCourse({ schoolId, courseId }) {
  assertSchoolActive(schoolId);

  const course = getCourseOrThrow(courseId);
  assertCourseSchoolAccess(schoolId, course);

  if (course.state !== "DRAFT_READY") throw new Error("COURSE_NOT_READY_TO_PUBLISH");

  course.state = "PUBLISHED";
  course.publishedAt = nowIso();
  course.updatedAt = nowIso();

  auditLog(schoolId, "COURSE_PUBLISHED", { courseId });
  return { ...course };
}

function listCoursesBySchool(schoolId) {
  if (!db.schools.has(schoolId)) throw new Error("SCHOOL_NOT_FOUND");
  const ids = courseIndex.bySchool.get(schoolId) || new Set();
  const out = [];
  for (const id of ids) {
    const c = db.courses.get(id);
    if (c) out.push({ ...c });
  }
  out.sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
  return out;
}

function getCoursePublicData(course) {
  const effective = getEffectivePrice(course.pricing);
  return {
    id: course.id,
    title: course.title,
    description: course.description,
    type: course.type,
    currency: course.pricing.currency,
    price: course.pricing.price,
    effectivePrice: effective,
    promo: course.pricing.promo,
    publishedAt: course.publishedAt,
  };
}

// -----------------------------
// Marketplace (public via host)
// -----------------------------
function publicHome({ host }) {
  const school = resolveSchoolByHost(host);
  if (!school) return null;

  const branding = db.branding.get(school.id) || null;
  const localization = db.localization.get(school.id) || null;

  return {
    school: {
      id: school.id,
      slug: school.slug,
      name: school.name,
      status: school.status,
    },
    branding: branding ? { ...branding } : null,
    localization: localization ? { ...localization } : null,
  };
}

function publicListCourses({ host, q, tag, category }) {
  const school = resolveSchoolByHost(host);
  if (!school) return null;

  const all = listCoursesBySchool(school.id).filter((c) => c.state === "PUBLISHED");

  const query = String(q || "").trim().toLowerCase();
  const tg = tag ? String(tag).trim().toLowerCase() : null;
  const cat = category ? String(category).trim().toLowerCase() : null;

  const filtered = all.filter((c) => {
    if (query) {
      const hay = `${c.title} ${c.description}`.toLowerCase();
      if (!hay.includes(query)) return false;
    }
    if (tg) {
      const tags = (c.tags || []).map((x) => String(x).toLowerCase());
      if (!tags.includes(tg)) return false;
    }
    if (cat) {
      if (!c.category || String(c.category).toLowerCase() !== cat) return false;
    }
    return true;
  });

  return filtered.map(getCoursePublicData);
}

function publicGetCoursePage({ host, courseId }) {
  const school = resolveSchoolByHost(host);
  if (!school) return null;

  const course = db.courses.get(courseId);
  if (!course) return null;
  if (course.schoolId !== school.id) return null;
  if (course.state !== "PUBLISHED") return null;

  // página do curso: básico + estrutura (sem conteúdo inteiro)
  return {
    course: getCoursePublicData(course),
    preview: {
      modules: (course.structure?.modules || []).map((m) => ({
        title: m.title,
        lessons: (m.lessons || []).map((l) => ({ title: l.title })),
      })),
    },
    cta: {
      action: "BUY",
      courseId: course.id,
    },
  };
}

// -----------------------------
// Orders + Payments + Webhooks + Enrollment
// -----------------------------
function createOrder({ schoolId, courseId, buyerEmail }) {
  assertSchoolActive(schoolId);

  const course = getCourseOrThrow(courseId);
  assertCourseSchoolAccess(schoolId, course);
  if (course.state !== "PUBLISHED") throw new Error("COURSE_NOT_FOR_SALE");

  const email = String(buyerEmail || "").trim().toLowerCase();
  if (!email.includes("@")) throw new Error("BUYER_EMAIL_INVALID");

  const price = getEffectivePrice(course.pricing);
  const order = {
    id: generateId("ord"),
    schoolId,
    courseId,
    buyerEmail: email,
    amount: price,
    currency: course.pricing.currency,
    status: "PENDING", // PENDING | PAID | FAILED | CANCELED
    createdAt: nowIso(),
    updatedAt: nowIso(),
    paidAt: null,
  };

  db.orders.set(order.id, order);

  if (!orderIndex.bySchool.has(schoolId)) orderIndex.bySchool.set(schoolId, new Set());
  orderIndex.bySchool.get(schoolId).add(order.id);

  const buyerKey = `${schoolId}:${email}`;
  if (!orderIndex.byBuyer.has(buyerKey)) orderIndex.byBuyer.set(buyerKey, new Set());
  orderIndex.byBuyer.get(buyerKey).add(order.id);

  const courseKey = `${schoolId}:${courseId}`;
  if (!orderIndex.byCourse.has(courseKey)) orderIndex.byCourse.set(courseKey, new Set());
  orderIndex.byCourse.get(courseKey).add(order.id);

  auditLog(schoolId, "ORDER_CREATED", { orderId: order.id, courseId, buyerEmail: email });
  return { ...order };
}

function startDemoCheckout({ schoolId, orderId, outcome }) {
  // outcome: "APPROVED" | "DECLINED"
  assertSchoolActive(schoolId);

  const order = db.orders.get(orderId);
  if (!order) throw new Error("ORDER_NOT_FOUND");
  if (order.schoolId !== schoolId) throw new Error("ORDER_ACCESS_DENIED");
  if (order.status !== "PENDING") throw new Error("ORDER_NOT_PENDING");

  const g = db.gateway.get(schoolId);
  if (!g || g.provider !== "DEMO") throw new Error("GATEWAY_NOT_CONFIGURED");

  const oc = String(outcome || "").trim().toUpperCase();
  if (!["APPROVED", "DECLINED"].includes(oc)) throw new Error("CHECKOUT_OUTCOME_INVALID");

  const payment = {
    id: generateId("pay"),
    schoolId,
    orderId,
    provider: "DEMO",
    status: "INITIATED", // INITIATED | SUCCEEDED | FAILED
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  db.payments.set(payment.id, payment);

  const eventId = generateId("whk");
  const payload = {
    provider: "DEMO",
    eventId,
    schoolId,
    orderId,
    paymentId: payment.id,
    result: oc, // APPROVED | DECLINED
    ts: nowIso(),
  };
  const signature = hmacSha256(g.webhookSecret, stableStringify(payload));

  // checkoutUrl mock (redirecionado)
  const checkoutUrl =
    `${PLATFORM.demoCheckoutBaseUrl}/checkout?orderId=${encodeURIComponent(orderId)}&result=${encodeURIComponent(oc)}`;

  auditLog(schoolId, "CHECKOUT_STARTED", { orderId, outcome: oc, paymentId: payment.id, eventId });

  return {
    checkoutUrl,
    webhook: {
      payload,
      signature,
    },
  };
}

function receiveWebhook({ provider, payload, signature }) {
  const prov = String(provider || payload?.provider || "").trim().toUpperCase();
  if (prov !== "DEMO") throw new Error("WEBHOOK_PROVIDER_UNSUPPORTED");

  const eventId = String(payload?.eventId || "").trim();
  if (!eventId) throw new Error("WEBHOOK_EVENT_ID_REQUIRED");

  // idempotência: se já recebemos, devolve o resultado anterior
  if (db.webhookEvents.has(eventId)) {
    const existing = db.webhookEvents.get(eventId);
    return { ...existing.resultSnapshot };
  }

  const schoolId = String(payload?.schoolId || "").trim();
  const orderId = String(payload?.orderId || "").trim();
  const paymentId = String(payload?.paymentId || "").trim();
  const result = String(payload?.result || "").trim().toUpperCase();

  if (!schoolId || !orderId || !paymentId) throw new Error("WEBHOOK_PAYLOAD_INVALID");
  if (!["APPROVED", "DECLINED"].includes(result)) throw new Error("WEBHOOK_RESULT_INVALID");

  const g = db.gateway.get(schoolId);
  if (!g) throw new Error("GATEWAY_NOT_CONFIGURED");

  // assinatura mock (HMAC real, mas conceito do MVP)
  const expected = hmacSha256(g.webhookSecret, stableStringify(payload));
  if (String(signature || "").trim() !== expected) throw new Error("WEBHOOK_SIGNATURE_INVALID");

  const order = db.orders.get(orderId);
  if (!order) throw new Error("ORDER_NOT_FOUND");
  if (order.schoolId !== schoolId) throw new Error("ORDER_ACCESS_DENIED");

  const payment = db.payments.get(paymentId);
  if (!payment) throw new Error("PAYMENT_NOT_FOUND");
  if (payment.schoolId !== schoolId) throw new Error("PAYMENT_ACCESS_DENIED");
  if (payment.orderId !== orderId) throw new Error("PAYMENT_ORDER_MISMATCH");

  // aplica efeito (1 vez)
  if (result === "APPROVED") {
    order.status = "PAID";
    order.paidAt = nowIso();
    order.updatedAt = nowIso();

    payment.status = "SUCCEEDED";
    payment.updatedAt = nowIso();

    // matrícula (idempotente também)
    ensureEnrollment({
      schoolId,
      buyerEmail: order.buyerEmail,
      courseId: order.courseId,
      orderId: order.id,
    });

    auditLog(schoolId, "PAYMENT_SUCCEEDED", { orderId, paymentId, eventId });
  } else {
    order.status = "FAILED";
    order.updatedAt = nowIso();

    payment.status = "FAILED";
    payment.updatedAt = nowIso();

    auditLog(schoolId, "PAYMENT_FAILED", { orderId, paymentId, eventId });
  }

  const snapshot = {
    ok: true,
    provider: prov,
    eventId,
    schoolId,
    orderId,
    paymentId,
    orderStatus: order.status,
  };

  // grava evento para idempotência/auditoria
  const evt = {
    id: eventId,
    provider: prov,
    schoolId,
    orderId,
    paymentId,
    receivedAt: nowIso(),
    payload: JSON.parse(stableStringify(payload)),
    signature: String(signature || ""),
    resultSnapshot: snapshot,
  };
  db.webhookEvents.set(eventId, evt);

  auditLog(schoolId, "WEBHOOK_RECEIVED", { eventId, orderId, result });

  return { ...snapshot };
}

function ensureEnrollment({ schoolId, buyerEmail, courseId, orderId }) {
  const key = `${schoolId}:${buyerEmail}:${courseId}`;
  const existingId = enrollmentIndex.bySchoolBuyerCourse.get(key);
  if (existingId) {
    const e = db.enrollments.get(existingId);
    return e ? { ...e } : null;
  }

  const enrollment = {
    id: generateId("enr"),
    schoolId,
    buyerEmail,
    courseId,
    orderId,
    createdAt: nowIso(),
  };

  db.enrollments.set(enrollment.id, enrollment);
  enrollmentIndex.bySchoolBuyerCourse.set(key, enrollment.id);

  auditLog(schoolId, "ENROLLMENT_CREATED", { enrollmentId: enrollment.id, courseId, buyerEmail });
  return { ...enrollment };
}

function canAccessCourse({ schoolId, buyerEmail, courseId }) {
  const key = `${schoolId}:${String(buyerEmail || "").trim().toLowerCase()}:${courseId}`;
  return enrollmentIndex.bySchoolBuyerCourse.has(key);
}

function listOrdersByBuyer({ schoolId, buyerEmail }) {
  if (!db.schools.has(schoolId)) throw new Error("SCHOOL_NOT_FOUND");
  const email = String(buyerEmail || "").trim().toLowerCase();
  const key = `${schoolId}:${email}`;
  const set = orderIndex.byBuyer.get(key) || new Set();
  const out = [];
  for (const id of set) {
    const o = db.orders.get(id);
    if (o) out.push({ ...o });
  }
  out.sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
  return out;
}

// -----------------------------
// Test helper
// -----------------------------
function __resetForTests() {
  db.schools.clear();
  db.domains.clear();
  db.branding.clear();
  db.localization.clear();
  db.gateway.clear();
  db.courses.clear();
  db.orders.clear();
  db.payments.clear();
  db.webhookEvents.clear();
  db.enrollments.clear();
  db.audit.clear();

  domainIndex.byCustomDomain.clear();
  domainIndex.bySubdomain.clear();

  courseIndex.bySchool.clear();

  orderIndex.bySchool.clear();
  orderIndex.byBuyer.clear();
  orderIndex.byCourse.clear();

  enrollmentIndex.bySchoolBuyerCourse.clear();
}

// -----------------------------
// Exports
// -----------------------------
module.exports = {
  PLATFORM,

  // schools
  createSchool,
  listSchools,
  setSchoolStatus,
  getSchoolStats,

  // domains
  requestCustomDomain,
  verifyCustomDomain,
  resolveSchoolByHost,
  listDomainsBySchool,

  // branding/localization
  getBranding,
  updateBranding,
  getLocalization,
  updateLocalization,

  // gateway
  getGatewayConfig,
  rotateWebhookSecret,

  // courses
  createCourseAI,
  createCourseImport,
  aiGenerateStructure,
  editCourseStructure,
  approveCourseStructure,
  aiGenerateFullCourse,
  setImportStructure,
  publishCourse,
  listCoursesBySchool,

  // marketplace public
  publicHome,
  publicListCourses,
  publicGetCoursePage,

  // commerce
  createOrder,
  startDemoCheckout,
  receiveWebhook,
  listOrdersByBuyer,
  canAccessCourse,

  // audit
  listAuditBySchool,

  // tests
  __resetForTests,
};
