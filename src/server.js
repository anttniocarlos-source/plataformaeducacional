// src/server.js
// Servidor MVP com interface HTML simples (sem ?host=)
// Rotas por escola via /:slug (ex.: /alpha, /beta)
// Deploy-friendly (Render): usa process.env.PORT

const express = require("express");
const core = require("./app");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

// ------------------- helpers HTML
function esc(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function layout(title, body) {
  return `<!doctype html>
<html lang="pt-br">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>${esc(title)}</title>
  <style>
    body{font-family:Arial,Helvetica,sans-serif;max-width:980px;margin:24px auto;padding:0 16px;line-height:1.4;background:#fafafa}
    h1,h2,h3{margin:0 0 10px 0}
    .row{display:flex;gap:16px;flex-wrap:wrap;align-items:stretch}
    .card{border:1px solid #ddd;border-radius:12px;padding:14px;background:#fff;flex:1;min-width:280px}
    .muted{color:#666}
    .pill{display:inline-block;padding:2px 10px;border:1px solid #ddd;border-radius:999px;font-size:12px}
    a{color:#0b62ff;text-decoration:none}
    a:hover{text-decoration:underline}
    code{background:#f3f3f3;padding:2px 6px;border-radius:8px}
    input,select{padding:8px;border:1px solid #ccc;border-radius:10px}
    button{padding:9px 14px;border:0;border-radius:10px;background:#0b62ff;color:#fff;cursor:pointer}
    button:hover{opacity:.92}
    .warn{background:#fff7e6;border:1px solid #ffe1a6}
    ul{margin:8px 0 0 18px}
    li{margin:6px 0}
  </style>
</head>
<body>
  <h1>${esc(title)}</h1>
  ${body}
</body>
</html>`;
}

function link(href, text) {
  return `<a href="${href}">${esc(text || href)}</a>`;
}

function getSchoolBySlug(slug) {
  const schools = core.listSchools();
  return schools.find((s) => s.slug === slug) || null;
}

// ------------------- demo seed
function seedDemo() {
  core.__resetForTests();

  const alpha = core.createSchool({ name: "Escola Alpha", slug: "alpha" });
  const beta = core.createSchool({ name: "Escola Beta", slug: "beta" });

  // mantém white-label no core (domínio próprio mock), mas UI navega por /alpha
  const req = core.requestCustomDomain({ schoolId: alpha.id, domain: "cursos.alpha.com.br" });
  core.verifyCustomDomain({ schoolId: alpha.id, domain: "cursos.alpha.com.br", token: req.verificationToken });

  // curso AI (pipeline mock completo)
  const ai = core.createCourseAI({
    schoolId: alpha.id,
    title: "Node Essencial",
    description: "Base sólida para começar no Node",
    price: 199.9,
  });

  core.aiGenerateStructure({
    schoolId: alpha.id,
    courseId: ai.id,
    inputs: { theme: "Node.js", audience: "iniciantes", level: "básico", hours: 10, language: "pt-BR" },
  });

  // opcional: edição de estrutura poderia ser feita aqui, mas não é necessário para demo
  core.approveCourseStructure({ schoolId: alpha.id, courseId: ai.id });
  core.aiGenerateFullCourse({ schoolId: alpha.id, courseId: ai.id });
  core.publishCourse({ schoolId: alpha.id, courseId: ai.id });

  // curso IMPORT
  const imp = core.createCourseImport({
    schoolId: alpha.id,
    title: "Curso Importado (Vídeo)",
    description: "Aulas via links externos",
    price: 99.0,
    promo: { type: "PERCENT", value: 20, untilIso: new Date(Date.now() + 86400000).toISOString() },
  });

  core.setImportStructure({
    schoolId: alpha.id,
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

  core.publishCourse({ schoolId: alpha.id, courseId: imp.id });

  return { alpha, beta, aiCourseId: ai.id, importCourseId: imp.id };
}

// ------------------- routes

app.get("/", (req, res) => {
  const schools = core.listSchools();
  const body = `
    <p class="muted">Interface do MVP. Primeiro clique em <code>/demo/reset</code> para criar dados de demonstração.</p>
    <div class="row">
      <div class="card warn">
        <h3>1) Criar/Resetar demo</h3>
        <p>${link("/demo/reset", "Clique aqui para popular o MVP")}</p>
      </div>
      <div class="card">
        <h3>Escolas existentes</h3>
        ${
          schools.length === 0
            ? "<p class='muted'>Nenhuma escola criada ainda.</p>"
            : `<ul>${schools
                .map(
                  (s) =>
                    `<li>${esc(s.name)} <span class="pill">${esc(s.status)}</span> — ${link(
                      `/${encodeURIComponent(s.slug)}`,
                      `abrir /${s.slug}`
                    )}</li>`
                )
                .join("")}</ul>`
        }
      </div>
    </div>
  `;
  res.type("html").send(layout("Plataforma Educacional — MVP", body));
});

app.get("/demo/reset", (req, res) => {
  const demo = seedDemo();
  const body = `
    <p>Demo criado com sucesso.</p>
    <ul>
      <li>${link("/alpha", "Abrir Escola Alpha")}</li>
      <li>${link("/beta", "Abrir Escola Beta")}</li>
    </ul>
    <p class="muted">Próximo passo: entre em <code>/alpha</code> e vá em “Cursos”.</p>
    <div class="card">
      <h3>IDs (para referência)</h3>
      <p class="muted">Você não precisa copiar IDs para navegar, mas ficam aqui:</p>
      <ul>
        <li>AI Course ID: <code>${esc(demo.aiCourseId)}</code></li>
        <li>Import Course ID: <code>${esc(demo.importCourseId)}</code></li>
      </ul>
    </div>
  `;
  res.type("html").send(layout("Demo pronto", body));
});

app.get("/:slug", (req, res) => {
  const slug = String(req.params.slug || "").trim().toLowerCase();
  const school = getSchoolBySlug(slug);
  if (!school) {
    return res.status(404).type("html").send(layout("Não encontrado", `<p>Escola não encontrada: <code>${esc(slug)}</code></p>`));
  }

  const branding = core.getBranding(school.id);
  const loc = core.getLocalization(school.id);

  const body = `
    <div class="row">
      <div class="card">
        <h2>${esc(branding?.publicName || school.name)}</h2>
        <p class="muted">Slug: <code>${esc(school.slug)}</code> • Status: <code>${esc(school.status)}</code></p>
        <p class="muted">Idioma: <code>${esc(loc?.defaultLanguage)}</code> • Moeda: <code>${esc(loc?.defaultCurrency)}</code></p>
        <p>${link(`/${slug}/courses`, "Ver cursos publicados")}</p>
      </div>
      <div class="card">
        <h3>Atalhos</h3>
        <ul>
          <li>${link(`/${slug}/courses`, "Cursos")}</li>
          <li>${link(`/${slug}/me/orders?email=aluno@exemplo.com`, "Minhas compras (exemplo)")}</li>
        </ul>
        <p class="muted">Dica: você pode comprar um curso e ver o acesso liberar automaticamente.</p>
      </div>
    </div>
  `;
  res.type("html").send(layout(`Escola — ${school.name}`, body));
});

app.get("/:slug/courses", (req, res) => {
  const slug = String(req.params.slug || "").trim().toLowerCase();
  const school = getSchoolBySlug(slug);
  if (!school) return res.status(404).type("html").send(layout("Não encontrado", `<p>Escola não encontrada.</p>`));

  const courses = core.listCoursesBySchool(school.id).filter((c) => c.state === "PUBLISHED");

  const body = `
    <p>${link(`/${slug}`, "Voltar")}</p>
    <div class="row">
      ${
        courses.length === 0
          ? `<div class="card"><p class="muted">Nenhum curso publicado ainda. Use <code>/demo/reset</code>.</p></div>`
          : courses
              .map((c) => {
                const price = `${c.pricing.currency} ${c.pricing.price}`;
                return `<div class="card">
                  <h3>${esc(c.title)}</h3>
                  <p class="muted">${esc(c.description)}</p>
                  <p>Preço: <code>${esc(price)}</code></p>
                  <p class="muted">Tipo: <code>${esc(c.type)}</code> • ID: <code>${esc(c.id)}</code></p>
                  <p>${link(`/${slug}/course/${encodeURIComponent(c.id)}`, "Ver página do curso")}</p>
                  <p>${link(
                    `/${slug}/buy/${encodeURIComponent(c.id)}?email=aluno@exemplo.com&outcome=APPROVED&auto=1`,
                    "Comprar (APROVADO, auto)"
                  )}</p>
                  <p>${link(
                    `/${slug}/buy/${encodeURIComponent(c.id)}?email=aluno@exemplo.com&outcome=DECLINED&auto=1`,
                    "Comprar (RECUSADO, auto)"
                  )}</p>
                </div>`;
              })
              .join("")
      }
    </div>
  `;
  res.type("html").send(layout(`Cursos — ${school.name}`, body));
});

app.get("/:slug/course/:courseId", (req, res) => {
  const slug = String(req.params.slug || "").trim().toLowerCase();
  const school = getSchoolBySlug(slug);
  if (!school) return res.status(404).type("html").send(layout("Não encontrado", `<p>Escola não encontrada.</p>`));

  const courseId = String(req.params.courseId || "").trim();
  const courses = core.listCoursesBySchool(school.id);
  const course = courses.find((c) => c.id === courseId && c.state === "PUBLISHED");
  if (!course) return res.status(404).type("html").send(layout("Não encontrado", `<p>Curso não encontrado/publicado.</p>`));

  const previewModules = (course.structure?.modules || []).map((m) => ({
    title: m.title,
    lessons: (m.lessons || []).map((l) => l.title),
  }));

  const body = `
    <p>${link(`/${slug}/courses`, "Voltar para cursos")}</p>
    <div class="card">
      <h2>${esc(course.title)}</h2>
      <p class="muted">${esc(course.description)}</p>
      <p>Preço: <code>${esc(course.pricing.currency)} ${esc(course.pricing.price)}</code></p>
      <p class="muted">ID: <code>${esc(course.id)}</code> • Tipo: <code>${esc(course.type)}</code></p>

      <h3>Preview</h3>
      <ul>
        ${previewModules
          .map((m) => `<li><b>${esc(m.title)}</b><br/><span class="muted">${m.lessons.map(esc).join(" • ")}</span></li>`)
          .join("")}
      </ul>

      <h3>Comprar (demo)</h3>
      <form method="GET" action="/${esc(slug)}/buy/${esc(course.id)}">
        <label>Email: <input name="email" value="aluno@exemplo.com" /></label>
        <label>Resultado:
          <select name="outcome">
            <option value="APPROVED">APPROVED</option>
            <option value="DECLINED">DECLINED</option>
          </select>
        </label>
        <label>Auto webhook:
          <select name="auto">
            <option value="1">sim</option>
            <option value="0">não</option>
          </select>
        </label>
        <button type="submit">Iniciar compra</button>
      </form>
    </div>
  `;
  res.type("html").send(layout(`Curso — ${course.title}`, body));
});

app.get("/:slug/buy/:courseId", (req, res) => {
  const slug = String(req.params.slug || "").trim().toLowerCase();
  const school = getSchoolBySlug(slug);
  if (!school) return res.status(404).type("html").send(layout("Não encontrado", `<p>Escola não encontrada.</p>`));

  const email = String(req.query.email || "").trim();
  const outcome = String(req.query.outcome || "APPROVED").trim().toUpperCase();
  const auto = String(req.query.auto || "0") === "1";

  try {
    const order = core.createOrder({ schoolId: school.id, courseId: req.params.courseId, buyerEmail: email });
    const checkout = core.startDemoCheckout({ schoolId: school.id, orderId: order.id, outcome });

    let result = null;
    if (auto) {
      result = core.receiveWebhook({
        provider: "DEMO",
        payload: checkout.webhook.payload,
        signature: checkout.webhook.signature,
      });
    }

    const body = `
      <p>${link(`/${slug}/courses`, "Voltar para cursos")}</p>
      <div class="card">
        <h3>Compra iniciada</h3>
        <p>Pedido: <code>${esc(order.id)}</code> • Status: <code>${esc(order.status)}</code></p>
        <p>CheckoutUrl (mock): <code>${esc(checkout.checkoutUrl)}</code></p>
        ${
          auto
            ? `<p>Webhook auto aplicado: <code>${esc(result.orderStatus)}</code></p>`
            : `<p class="muted">Auto webhook desligado. Você pode enviar manualmente para <code>POST /webhook/demo</code>.</p>`
        }
        <p>${link(`/${slug}/me/orders?email=${encodeURIComponent(email)}`, "Ver minhas compras")}</p>
        <p>${link(`/${slug}/me/access?email=${encodeURIComponent(email)}&courseId=${encodeURIComponent(req.params.courseId)}`, "Verificar acesso")}</p>
      </div>
    `;
    res.type("html").send(layout("Checkout demo", body));
  } catch (e) {
    res
      .status(400)
      .type("html")
      .send(layout("Erro", `<p>Erro: <code>${esc(e.message || e)}</code></p><p>${link(`/${slug}/courses`, "Voltar")}</p>`));
  }
});

app.get("/:slug/me/orders", (req, res) => {
  const slug = String(req.params.slug || "").trim().toLowerCase();
  const school = getSchoolBySlug(slug);
  if (!school) return res.status(404).type("html").send(layout("Não encontrado", `<p>Escola não encontrada.</p>`));

  const email = String(req.query.email || "").trim().toLowerCase();
  const orders = core.listOrdersByBuyer({ schoolId: school.id, buyerEmail: email });

  const body = `
    <p>${link(`/${slug}`, "Voltar")}</p>
    <div class="card">
      <h3>Pedidos de ${esc(email)}</h3>
      ${
        orders.length === 0
          ? `<p class="muted">Nenhum pedido encontrado.</p>`
          : `<ul>${orders
              .map((o) => `<li><code>${esc(o.id)}</code> — <code>${esc(o.status)}</code> — ${esc(o.currency)} ${esc(o.amount)}</li>`)
              .join("")}</ul>`
      }
    </div>
  `;
  res.type("html").send(layout("Minhas compras", body));
});

app.get("/:slug/me/access", (req, res) => {
  const slug = String(req.params.slug || "").trim().toLowerCase();
  const school = getSchoolBySlug(slug);
  if (!school) return res.status(404).type("html").send(layout("Não encontrado", `<p>Escola não encontrada.</p>`));

  const email = String(req.query.email || "").trim().toLowerCase();
  const courseId = String(req.query.courseId || "").trim();
  const can = core.canAccessCourse({ schoolId: school.id, buyerEmail: email, courseId });

  const body = `
    <p>${link(`/${slug}`, "Voltar")}</p>
    <div class="card">
      <h3>Verificar acesso</h3>
      <p>Email: <code>${esc(email)}</code></p>
      <p>Curso: <code>${esc(courseId)}</code></p>
      <p>Resultado: ${can ? "<b>LIBERADO</b>" : "<b>NÃO LIBERADO</b>"}</p>
    </div>
  `;
  res.type("html").send(layout("Acesso", body));
});

// Mantém endpoint de webhook (para testes manuais, se você quiser)
app.post("/webhook/demo", (req, res) => {
  try {
    const { payload, signature } = req.body || {};
    const result = core.receiveWebhook({ provider: "DEMO", payload, signature });
    res.json({ ok: true, result });
  } catch (e) {
    res.status(400).json({ error: String(e.message || e) });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`MVP UI running on port ${PORT}`);
  console.log(`Abra /demo/reset e depois /alpha`);
});
