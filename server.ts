import puppeteer from "puppeteer";
import { z } from "zod";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

const r2 = new S3Client({
    region: "auto",
    endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID!,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
    },
});

const BasicsSchema = z.object({
    full_name: z.string(),
    headline: z.string(),
    email: z.string().email().optional(),
    phone: z.string().optional(),
    location: z.string().optional(),
    linkedin: z.string().optional(),
    github: z.string().optional(),
    portfolio: z.string().optional(),
});

const SkillsSchema = z.object({
    technical: z.array(z.string()),
    soft: z.array(z.string()).optional(),
});

const ExperienceSchema = z.object({
    company: z.string(),
    title: z.string(),
    location: z.string().optional(),
    start_date: z.string(),
    end_date: z.string().nullable().optional(),
    highlights: z.array(z.string()),
    technologies: z.array(z.string()).optional(),
});

const EducationSchema = z.object({
    institution: z.string(),
    degree: z.string().optional(),
    field_of_study: z.string().optional(),
    start_date: z.string().optional(),
    end_date: z.string().nullable().optional(),
});

const ProjectSchema = z.object({
    name: z.string(),
    description: z.string().optional(),
    technologies: z.array(z.string()).optional(),
    impact: z.string().optional(),
});

const ResumeSchema = z.object({
    basics: BasicsSchema,
    summary: z.string().optional(),
    skills: SkillsSchema,
    experience: z.array(ExperienceSchema),
    education: z.array(EducationSchema),
    projects: z.array(ProjectSchema).optional(),
    certifications: z.array(z.string()).optional(),
    keywords: z.array(z.string()).optional(),
});

const RequestBodySchema = z.object({
    username: z.string(),
    resume: ResumeSchema,
});

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
            const body = await req.json();
            const parsed = RequestBodySchema.safeParse(body);

            if (!parsed.success) {
                return new Response(
                    JSON.stringify({ error: "Invalid request body", details: parsed.error.flatten() }),
                    { status: 400, headers: { "Content-Type": "application/json" } }
                );
            }

            const { username, resume } = parsed.data;

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

            const key = `resumes/${username}.pdf`;
            await r2.send(new PutObjectCommand({
                Bucket: process.env.R2_BUCKET_NAME!,
                Key: key,
                Body: pdfBuffer,
                ContentType: "application/pdf",
            }));

            const url = `${process.env.R2_PUBLIC_URL}/${key}`;

            return new Response(
                JSON.stringify({ url }),
                { status: 200, headers: { "Content-Type": "application/json" } }
            );

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
