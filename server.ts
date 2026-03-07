import puppeteer from "puppeteer";
import { z } from "zod";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

function getEnvValue(...keys: string[]) {
    for (const key of keys) {
        const value = process.env[key];
        if (typeof value === "string") {
            const trimmed = value.trim();
            if (trimmed.length > 0) return trimmed;
        }
    }

    return undefined;
}

function requireEnvValue(label: string, ...keys: string[]) {
    const value = getEnvValue(...keys);
    if (!value) {
        throw new Error(`Missing required env var for ${label}. Expected one of: ${keys.join(", ")}`);
    }

    return value;
}

const R2_ACCOUNT_ID = requireEnvValue("R2 account id", "R2_ACCOUNT_ID", "ACCOUNT_ID", "account_id");
const R2_ACCESS_KEY_ID = requireEnvValue("R2 access key id", "R2_ACCESS_KEY_ID", "ACCESS_KEY_ID", "access_key_id");
const R2_SECRET_ACCESS_KEY = requireEnvValue("R2 secret access key", "R2_SECRET_ACCESS_KEY", "SECRET_ACCESS_KEY", "secret_access_key");
const R2_BUCKET_NAME = requireEnvValue("R2 bucket name", "R2_BUCKET_NAME", "BUCKET_NAME", "bucket_name");
const R2_PUBLIC_URL = requireEnvValue("R2 public url", "R2_PUBLIC_URL", "PUBLIC_URL", "public_url").replace(/\/$/, "");

const r2 = new S3Client({
    region: "auto",
    endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    forcePathStyle: true,
    credentials: {
        accessKeyId: R2_ACCESS_KEY_ID,
        secretAccessKey: R2_SECRET_ACCESS_KEY,
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
        const { pathname } = new URL(req.url);

        if (pathname === "/health") {
            return new Response(JSON.stringify({ status: "ok" }), {
                headers: { "Content-Type": "application/json" },
            });
        }

        if (req.method !== "POST") {
            return new Response("Not Found", { status: 404 });
        }

        if (pathname !== "/generate") {
            return new Response("Not Found", { status: 404 });
        }

        const requestId = crypto.randomUUID().slice(0, 8);
        const log = (msg: string, data?: Record<string, unknown>) =>
            console.log(JSON.stringify({ requestId, ts: new Date().toISOString(), msg, ...data }));

        try {
            log("request received", { method: req.method, url: req.url });

            const body = await req.json();
            const parsed = RequestBodySchema.safeParse(body);

            if (!parsed.success) {
                log("validation failed", { errors: parsed.error.flatten() });
                return new Response(
                    JSON.stringify({ error: "Invalid request body", details: parsed.error.flatten() }),
                    { status: 400, headers: { "Content-Type": "application/json" } }
                );
            }

            const { username, resume } = parsed.data;
            log("launching browser", { username });

            const browser = await puppeteer.launch({
                headless: true,
                args: ["--no-sandbox", "--disable-setuid-sandbox"]
            });

            const html = generateHTML(resume);
            const page = await browser.newPage();
            await page.setContent(html, { waitUntil: "networkidle0" });
            log("html rendered");

            const pdfBuffer = await page.pdf({
                format: "A4",
                printBackground: true
            });

            await browser.close();
            log("pdf generated", { bytes: pdfBuffer.byteLength });

            const key = `resumes/${username}.pdf`;
            log("uploading to r2", { key, bucket: R2_BUCKET_NAME });

            await r2.send(new PutObjectCommand({
                Bucket: R2_BUCKET_NAME,
                Key: key,
                Body: pdfBuffer,
                ContentType: "application/pdf",
            }));

            const url = `${R2_PUBLIC_URL}/${key}`;
            log("upload complete", { url });

            return new Response(
                JSON.stringify({ url }),
                { status: 200, headers: { "Content-Type": "application/json" } }
            );

        } catch (err) {
            const detail = err instanceof Error ? { message: err.message, stack: err.stack } : { raw: String(err) };
            console.error(JSON.stringify({ requestId, ts: new Date().toISOString(), msg: "unhandled error", ...detail }));
            return new Response(
                JSON.stringify({ error: "PDF generation failed", detail: err instanceof Error ? err.message : String(err) }),
                { status: 500, headers: { "Content-Type": "application/json" } }
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
