// src/server.js
// Servidor mínimo para "ver o MVP" no navegador (Replit)
// Dep: npm i express

const express = require("express");
const app = require("./app");

const server = express();
server.use(express.json());

const PORT = process.env.PORT || 3000;

// -------- Helpers
function getHost(req) {
  // No Replit você não controla o Host real, então usamos ?host= para simular
  return (req.query.host || req.headers["x-demo-host"] || req.headers.host || "").toString();
}

function requireSchoolByHost(req, res) {
  const host = getHost(req);
  const school = app.resolveSchoolByHost(host);
  if (!school) {
    res.status(404).json({
      error: "SCHOOL_NOT_FOUND_FOR_HOST",
      hint: "Use ?host=cursos.alpha.com.br (após /demo/reset).",
      receivedHost: host,
    });
    return null;
  }
  return { host, school };
}

// -------- Demo seed (para você visualizar sem criar tudo na mão)
function seedDemo() {
  app.__resetForTests();

  const s1 = app.createSchool({ name: "Escola Alpha", slug: "alpha" });
  const s2 = app.createSchool({ name: "Escola Beta", slug: "beta" });

  // Domínio próprio Alpha (mock token)
  const req = app.requestCustomDomain({ schoolId: s1.id, domain: "cursos.alpha.com.br" });
  app.verifyCustomDomain({ schoolId: s1.id, domain: "cursos.alpha.com.br", token: req.verificationToken });

  // Curso AI Alpha
  const ai = app.createCourseAI({
    schoolId: s1.id,
    title: "Node Essencial",
    description: "Base sólida para começar no Node",
    price: 199.9,
  });

  app.aiGenerateStructure({
    schoolId: s1.id,
    courseId: ai.id,
    inputs: { theme: "Node.js", audience: "iniciantes", level: "básico", hours: 10, language: "pt-BR" },
  });

  app.approveCourseStructure({ schoolId: s1.id, courseId: ai.id });
  app.aiGenerateFullCourse({ schoolId: s1.id, courseId: ai.id });
  app.publishCourse({ schoolId: s1.id, courseId: ai.id });

  // Curso Import Alpha
  const imp = app.createCourseImport({
    schoolId: s1.id,
    title: "Curso Importado (Vídeo)",
    description: "Aulas via links externos",
    price: 99.0,
    promo: { type: "PERCENT", value: 20, untilIso: new Date(Date.now() + 86400000).toISOString() },
  });

  app.setImportStructure({
    schoolId: s1.id,
    courseId: imp.id,
    structure: {
      modules: [
        {
          title: "Módulo Único",
          lessons: [
            { title: "Aula 1", externalUrl: "https://video.example/a1" },
            { title: "Aula 2", externalUrl: "https://video.example/a2" },
          ],
        },
      ],
    },
  });

  app.publishCourse({ schoolId: s1.id, courseId: imp.id });

  // Beta não precisa de domínio próprio; usa subdomínio
  const betaHost = `beta.${app.PLATFORM.baseDomain}`;

  return {
    alpha: { schoolId: s1.id, host: "cursos.alpha.com.br", aiCourseId: ai.id, importCourseId: imp.id },
    beta: { schoolId: s2.id, host: betaHost },
  };
}

// -------- Routes

server.get("/demo/reset", (req, res) => {
  const demo = seedDemo();
  res.json({
    ok: true,
    message: "Demo resetado e populado.",
    try: [
      `/?host=${demo.alpha.host}`,
      `/courses?host=${demo.alpha.host}`,
      `/buy/${demo.alpha.aiCourseId}?host=${demo.alpha.host}&email=aluno@exemplo.com&outcome=APPROVED&auto=1`,
      `/me/orders?host=${demo.alpha.host}&email=aluno@exemplo.com`,
      `/me/access?host=${demo.alpha.host}&email=aluno@exemplo.com&courseId=${demo.alpha.aiCourseId}`,
      `/?host=${demo.beta.host}`,
    ],
    demo,
  });
});

server.get("/", (req, res) => {
  const ctx = requireSchoolByHost(req, res);
  if (!ctx) return;

  const home = app.publicHome({ host: ctx.host });
  res.json({
    ok: true,
    host: ctx.host,
    home,
    routes: [
      `/courses?host=${encodeURIComponent(ctx.host)}`,
      `/course/:id?host=${encodeURIComponent(ctx.host)}`,
      `/buy/:courseId?host=${encodeURIComponent(ctx.host)}&email=aluno@exemplo.com&outcome=APPROVED&auto=1`,
    ],
  });
});

server.get("/courses", (req, res) => {
  const ctx = requireSchoolByHost(req, res);
  if (!ctx) return;

  const courses = app.publicListCourses({
    host: ctx.host,
    q: req.query.q,
    tag: req.query.tag,
    category: req.query.category,
  });

  res.json({ ok: true, host: ctx.host, courses });
});

server.get("/course/:id", (req, res) => {
  const ctx = requireSchoolByHost(req, res);
  if (!ctx) return;

  const page = app.publicGetCoursePage({ host: ctx.host, courseId: req.params.id });
  if (!page) {
    res.status(404).json({ error: "COURSE_NOT_FOUND_OR_NOT_PUBLISHED_OR_WRONG_TENANT" });
    return;
  }
  res.json({ ok: true, host: ctx.host, page });
});

server.get("/buy/:courseId", (req, res) => {
  const ctx = requireSchoolByHost(req, res);
  if (!ctx) return;

  const email = (req.query.email || "").toString();
  const outcome = (req.query.outcome || "APPROVED").toString().toUpperCase();
  const auto = (req.query.auto || "0").toString() === "1";

  try {
    const order = app.createOrder({ schoolId: ctx.school.id, courseId: req.params.courseId, buyerEmail: email });
    const checkout = app.startDemoCheckout({ schoolId: ctx.school.id, orderId: order.id, outcome });

    let webhookResult = null;
    if (auto) {
      webhookResult = app.receiveWebhook({
        provider: "DEMO",
        payload: checkout.webhook.payload,
        signature: checkout.webhook.signature,
      });
    }

    res.json({
      ok: true,
      host: ctx.host,
      order,
      checkoutUrl: checkout.checkoutUrl,
      webhookToSendManually: checkout.webhook,
      autoWebhookResult: webhookResult,
      next: {
        myOrders: `/me/orders?host=${encodeURIComponent(ctx.host)}&email=${encodeURIComponent(email)}`,
        accessCheck: `/me/access?host=${encodeURIComponent(ctx.host)}&email=${encodeURIComponent(email)}&courseId=${encodeURIComponent(
          req.params.courseId
        )}`,
      },
    });
  } catch (e) {
    res.status(400).json({ error: String(e.message || e) });
  }
});

server.post("/webhook/demo", (req, res) => {
  try {
    const { payload, signature } = req.body || {};
    const result = app.receiveWebhook({ provider: "DEMO", payload, signature });
    res.json({ ok: true, result });
  } catch (e) {
    res.status(400).json({ error: String(e.message || e) });
  }
});

server.get("/me/orders", (req, res) => {
  const ctx = requireSchoolByHost(req, res);
  if (!ctx) return;

  const email = (req.query.email || "").toString();
  try {
    const orders = app.listOrdersByBuyer({ schoolId: ctx.school.id, buyerEmail: email });
    res.json({ ok: true, host: ctx.host, buyerEmail: email, orders });
  } catch (e) {
    res.status(400).json({ error: String(e.message || e) });
  }
});

server.get("/me/access", (req, res) => {
  const ctx = requireSchoolByHost(req, res);
  if (!ctx) return;

  const email = (req.query.email || "").toString();
  const courseId = (req.query.courseId || "").toString();
  try {
    const can = app.canAccessCourse({ schoolId: ctx.school.id, buyerEmail: email, courseId });
    res.json({ ok: true, host: ctx.host, buyerEmail: email, courseId, canAccess: can });
  } catch (e) {
    res.status(400).json({ error: String(e.message || e) });
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`1) Abra: /demo/reset`);
  console.log(`2) Depois: /?host=cursos.alpha.com.br`);
});
