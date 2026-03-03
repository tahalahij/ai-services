import puppeteer from "puppeteer";

const server = Bun.serve({
    port: process.env.PORT || 3000,

    async fetch(req) {
        if (req.method !== "POST") {
            return new Response("Not Found", { status: 404 });
        }

        if (new URL(req.url).pathname !== "/generate") {
            return new Response("Not Found", { status: 404 });
        }

        try {
            const { username, resume } = await req.json();

            if (!resume?.basics?.full_name) {
                return new Response(
                    JSON.stringify({ error: "Invalid resume format" }),
                    { status: 400 }
                );
            }

            const html = generateHTML(resume);

            const browser = await puppeteer.launch({
                headless: "new",
                args: ["--no-sandbox", "--disable-setuid-sandbox"]
            });

            const page = await browser.newPage();
            await page.setContent(html, { waitUntil: "networkidle0" });

            const pdfBuffer = await page.pdf({
                format: "A4",
                printBackground: true
            });

            await browser.close();

            return new Response(pdfBuffer, {
                headers: {
                    "Content-Type": "application/pdf",
                    "Content-Disposition": `attachment; filename="${username}.pdf"`
                }
            });

        } catch (err) {
            console.error(err);
            return new Response(
                JSON.stringify({ error: "PDF generation failed" }),
                { status: 500 }
            );
        }
    }
});

console.log(`PDF service running on port ${server.port}`);

function generateHTML(resume: any) {
    const {
        basics,
        summary,
        skills,
        experience,
        education
    } = resume;

    return `
  <html>
  <head>
    <style>
      body { font-family: Arial; padding: 40px; }
      h1 { margin-bottom: 0; }
      h2 { margin-top: 30px; border-bottom: 1px solid #ddd; }
      ul { margin-top: 5px; }
    </style>
  </head>
  <body>
    <h1>${basics.full_name}</h1>
    <p>${basics.headline}</p>
    <p>${basics.email ?? ""} | ${basics.location ?? ""}</p>

    <h2>Summary</h2>
    <p>${summary}</p>

    <h2>Skills</h2>
    <ul>
      ${skills.technical.map((s: string) => `<li>${s}</li>`).join("")}
    </ul>

    <h2>Experience</h2>
    ${experience.map((exp: any) => `
      <div>
        <strong>${exp.title}</strong> — ${exp.company}
        <div>${exp.start_date} - ${exp.end_date ?? "Present"}</div>
        <ul>
          ${exp.highlights.map((h: string) => `<li>${h}</li>`).join("")}
        </ul>
      </div>
    `).join("")}

    <h2>Education</h2>
    ${education.map((ed: any) => `
      <div>
        <strong>${ed.institution}</strong>
        <div>${ed.degree ?? ""} ${ed.field_of_study ?? ""}</div>
      </div>
    `).join("")}
  </body>
  </html>
  `;
}
