import puppeteer from "puppeteer";
import { z } from "zod";
import { PutObjectCommand, S3Client, S3ServiceException } from "@aws-sdk/client-s3";

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

function getBooleanEnvValue(keys: string[], defaultValue = false) {
    const value = getEnvValue(...keys);
    if (!value) return defaultValue;

    const normalized = value.toLowerCase();
    return ["1", "true", "yes", "on"].includes(normalized);
}

function maskSecret(value: string, visible = 4) {
    if (value.length <= visible * 2) {
        return "*".repeat(value.length);
    }

    return `${value.slice(0, visible)}${"*".repeat(Math.max(4, value.length - visible * 2))}${value.slice(-visible)}`;
}

const R2_ACCOUNT_ID = requireEnvValue("R2 account id", "R2_ACCOUNT_ID", "ACCOUNT_ID", "account_id");
const R2_ACCESS_KEY_ID = requireEnvValue("R2 access key id", "R2_ACCESS_KEY_ID", "ACCESS_KEY_ID", "access_key_id");
const R2_SECRET_ACCESS_KEY = requireEnvValue("R2 secret access key", "R2_SECRET_ACCESS_KEY", "SECRET_ACCESS_KEY", "secret_access_key");
const R2_BUCKET_NAME = requireEnvValue("R2 bucket name", "R2_BUCKET_NAME", "BUCKET_NAME", "bucket_name");
const R2_PUBLIC_URL = requireEnvValue("R2 public url", "R2_PUBLIC_URL", "PUBLIC_URL", "public_url").replace(/\/$/, "");
const R2_ENDPOINT = getEnvValue("R2_ENDPOINT", "S3_ENDPOINT", "AWS_ENDPOINT") ?? `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;
const R2_FORCE_PATH_STYLE = getBooleanEnvValue(["R2_FORCE_PATH_STYLE", "S3_FORCE_PATH_STYLE", "AWS_FORCE_PATH_STYLE"], false);

const r2 = new S3Client({
    region: "auto",
    endpoint: R2_ENDPOINT,
    forcePathStyle: R2_FORCE_PATH_STYLE,
    credentials: {
        accessKeyId: R2_ACCESS_KEY_ID,
        secretAccessKey: R2_SECRET_ACCESS_KEY,
    },
});

console.log(JSON.stringify({
    ts: new Date().toISOString(),
    msg: "r2 client configured",
    bucket: R2_BUCKET_NAME,
    endpoint: R2_ENDPOINT,
    publicUrl: R2_PUBLIC_URL,
    forcePathStyle: R2_FORCE_PATH_STYLE,
    accountIdPreview: maskSecret(R2_ACCOUNT_ID),
    accessKeyPreview: maskSecret(R2_ACCESS_KEY_ID),
    secretLength: R2_SECRET_ACCESS_KEY.length,
}));

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
            log("resume parsed", {
                username,
                summary: summarizeResume(resume),
            });
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
            log("uploading to r2", {
                key,
                bucket: R2_BUCKET_NAME,
                endpoint: R2_ENDPOINT,
                forcePathStyle: R2_FORCE_PATH_STYLE,
            });

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
            if (err instanceof S3ServiceException) {
                console.error(JSON.stringify({
                    requestId,
                    ts: new Date().toISOString(),
                    msg: "r2 upload failed",
                    name: err.name,
                    message: err.message,
                    bucket: R2_BUCKET_NAME,
                    endpoint: R2_ENDPOINT,
                    forcePathStyle: R2_FORCE_PATH_STYLE,
                    httpStatusCode: err.$metadata?.httpStatusCode,
                    requestIdFromProvider: err.$metadata?.requestId,
                    extendedRequestId: err.$metadata?.extendedRequestId,
                    cfId: err.$metadata?.cfId,
                    attempts: err.$metadata?.attempts,
                    totalRetryDelay: err.$metadata?.totalRetryDelay,
                    stack: err.stack,
                }));
            }

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

function escapeHtml(value: unknown) {
        return String(value ?? "")
                .replaceAll("&", "&amp;")
                .replaceAll("<", "&lt;")
                .replaceAll(">", "&gt;")
                .replaceAll('"', "&quot;")
                .replaceAll("'", "&#39;");
}

function formatDate(value?: string | null) {
        if (!value) return "Present";

        const date = new Date(value);
        if (Number.isNaN(date.getTime())) {
                return escapeHtml(value);
        }

        return new Intl.DateTimeFormat("en", {
                year: "numeric",
                month: "short",
        }).format(date);
}

function renderTagList(items?: string[]) {
        if (!items?.length) return "";

        return `
            <div class="chip-row">
                ${items.map((item) => `<span class="chip">${escapeHtml(item)}</span>`).join("")}
            </div>
        `;
}

function summarizeResume(resume: any) {
    return {
        fullName: resume?.basics?.full_name,
        headline: resume?.basics?.headline,
        email: resume?.basics?.email,
        location: resume?.basics?.location,
        technicalSkills: resume?.skills?.technical?.length ?? 0,
        softSkills: resume?.skills?.soft?.length ?? 0,
        experienceCount: resume?.experience?.length ?? 0,
        educationCount: resume?.education?.length ?? 0,
        projectCount: resume?.projects?.length ?? 0,
        certificationCount: resume?.certifications?.length ?? 0,
        keywordCount: resume?.keywords?.length ?? 0,
    };
}

function generateHTML(resume: any) {
    const {
        basics,
        summary,
        skills,
                experience,
                education,
                projects,
                certifications,
                keywords,
    } = resume;

        const contactItems = [
                basics.email,
                basics.phone,
                basics.location,
                basics.linkedin,
                basics.github,
                basics.portfolio,
        ].filter(Boolean);

    return `
  <html>
  <head>
    <style>
            * { box-sizing: border-box; }
            body {
                font-family: Arial, sans-serif;
                padding: 32px;
                color: #1f2937;
                line-height: 1.45;
                font-size: 12px;
            }
            h1 {
                margin: 0;
                font-size: 28px;
                color: #111827;
            }
            .headline {
                margin: 6px 0 10px;
                font-size: 14px;
                color: #374151;
            }
            .contact {
                color: #4b5563;
                margin-bottom: 18px;
            }
            h2 {
                margin: 22px 0 10px;
                font-size: 15px;
                color: #111827;
                border-bottom: 1px solid #d1d5db;
                padding-bottom: 4px;
            }
            h3 {
                margin: 0;
                font-size: 13px;
                color: #111827;
            }
            p { margin: 6px 0; }
            ul {
                margin: 6px 0 0;
                padding-left: 18px;
            }
            li { margin-bottom: 4px; }
            .section-block { margin-bottom: 12px; }
            .row {
                display: flex;
                justify-content: space-between;
                gap: 12px;
                align-items: baseline;
            }
            .muted { color: #6b7280; }
            .chip-row { margin-top: 6px; }
            .chip {
                display: inline-block;
                margin: 0 6px 6px 0;
                padding: 3px 8px;
                border-radius: 999px;
                background: #eef2ff;
                color: #3730a3;
                font-size: 11px;
            }
            .two-col {
                display: grid;
                grid-template-columns: 1fr 1fr;
                gap: 16px;
            }
    </style>
  </head>
  <body>
        <h1>${escapeHtml(basics.full_name)}</h1>
        <div class="headline">${escapeHtml(basics.headline)}</div>
        ${contactItems.length ? `<div class="contact">${contactItems.map((item: string) => escapeHtml(item)).join(" • ")}</div>` : ""}

        ${summary ? `
            <h2>Summary</h2>
            <p>${escapeHtml(summary)}</p>
        ` : ""}

    <h2>Skills</h2>
        <div class="two-col">
            <div>
                <h3>Technical</h3>
                ${renderTagList(skills.technical)}
            </div>
            ${skills.soft?.length ? `
                <div>
                    <h3>Soft Skills</h3>
                    ${renderTagList(skills.soft)}
                </div>
            ` : ""}
        </div>

    <h2>Experience</h2>
    ${experience.map((exp: any) => `
            <div class="section-block">
                <div class="row">
                    <h3>${escapeHtml(exp.title)} — ${escapeHtml(exp.company)}</h3>
                    <div class="muted">${formatDate(exp.start_date)} - ${formatDate(exp.end_date)}</div>
                </div>
                ${exp.location ? `<div class="muted">${escapeHtml(exp.location)}</div>` : ""}
        <ul>
                    ${exp.highlights.map((h: string) => `<li>${escapeHtml(h)}</li>`).join("")}
        </ul>
                ${exp.technologies?.length ? renderTagList(exp.technologies) : ""}
      </div>
    `).join("")}

    <h2>Education</h2>
    ${education.map((ed: any) => `
            <div class="section-block">
                <div class="row">
                    <h3>${escapeHtml(ed.institution)}</h3>
                    <div class="muted">${formatDate(ed.start_date)} - ${formatDate(ed.end_date)}</div>
                </div>
                <div>${escapeHtml([ed.degree, ed.field_of_study].filter(Boolean).join(" • "))}</div>
      </div>
    `).join("")}

        ${projects?.length ? `
            <h2>Projects</h2>
            ${projects.map((project: any) => `
                <div class="section-block">
                    <h3>${escapeHtml(project.name)}</h3>
                    ${project.description ? `<p>${escapeHtml(project.description)}</p>` : ""}
                    ${project.impact ? `<p><strong>Impact:</strong> ${escapeHtml(project.impact)}</p>` : ""}
                    ${project.technologies?.length ? renderTagList(project.technologies) : ""}
                </div>
            `).join("")}
        ` : ""}

        ${certifications?.length ? `
            <h2>Certifications</h2>
            <ul>
                ${certifications.map((cert: string) => `<li>${escapeHtml(cert)}</li>`).join("")}
            </ul>
        ` : ""}

        ${keywords?.length ? `
            <h2>Keywords</h2>
            ${renderTagList(keywords)}
        ` : ""}
  </body>
  </html>
  `;
}
