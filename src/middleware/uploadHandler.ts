import multer, { type FileFilterCallback } from "multer";
import path from "path";
import crypto from "crypto";
import fs from "fs";
import type { Request } from "express";
import { AppError } from "./errorHandler.js";

// ─── CONFIGURATION ────────────────────────────────────────────────────────────
const MAX_FILE_SIZE_MB  = 10;
const MAX_FILE_SIZE     = MAX_FILE_SIZE_MB * 1024 * 1024; // 10 Mo
const UPLOAD_DIR        = process.env.UPLOAD_DIR || "./uploads";

// Types de fichiers autorisés (MIME type + extension — double vérification)
const ALLOWED_TYPES: Record<string, string[]> = {
  "application/pdf":                          [".pdf"],
  "image/jpeg":                               [".jpg", ".jpeg"],
  "image/png":                                [".png"],
  "image/webp":                               [".webp"],
  "application/vnd.ms-excel":                 [".xls"],
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": [".xlsx"],
  "text/csv":                                 [".csv"],
  // Formats bancaires
  "text/plain":                               [".txt", ".mt940", ".sta", ".cfonb", ".camt", ".ofx", ".qif"],
  "application/xml":                          [".xml"],
  "text/xml":                                 [".xml"],
  "application/x-ofx":                       [".ofx", ".qbo"],
  "application/vnd.intu.qbo":                [".qbo"],
  "application/x-qif":                       [".qif"],
};

// ─── CRÉER LE DOSSIER UPLOAD SI INEXISTANT ───────────────────────────────────
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

// ─── STOCKAGE LOCAL ───────────────────────────────────────────────────────────
// En production → remplacer par S3 (voir section S3 plus bas)
const localStorage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, UPLOAD_DIR);
  },
  filename: (_req, file, cb) => {
    // Nom aléatoire sécurisé — jamais le nom original (path traversal, overwrite)
    const randomName = crypto.randomBytes(32).toString("hex");
    const ext        = path.extname(file.originalname).toLowerCase();
    cb(null, `${randomName}${ext}`);
  },
});

// ─── FILTRE SÉCURITÉ ──────────────────────────────────────────────────────────
function fileFilter(
  _req: Request,
  file: Express.Multer.File,
  cb: FileFilterCallback,
) {
  const BANK_EXTENSIONS = [".csv", ".xls", ".xlsx", ".ofx", ".qbo", ".qif", ".xml", ".mt940", ".sta", ".cfonb", ".txt", ".camt"];
  const mimeAllowed = file.mimetype in ALLOWED_TYPES;
  const ext         = path.extname(file.originalname).toLowerCase();
  // For bank file imports, allow by extension even if MIME type is generic text/plain
  const extAllowed  = mimeAllowed && ALLOWED_TYPES[file.mimetype].includes(ext)
    || (BANK_EXTENSIONS.includes(ext) && (file.mimetype.startsWith("text/") || file.mimetype === "application/xml" || file.mimetype === "application/octet-stream"));

  if (!mimeAllowed && !extAllowed) {
    return cb(
      new AppError(
        "INVALID_FILE_TYPE",
        `Type de fichier non autorisé. Types acceptés : PDF, JPEG, PNG, WEBP, Excel, CSV, OFX, QIF, CAMT, MT940, CFONB.`,
        400,
      ),
    );
  }

  cb(null, true);
}

// ─── INSTANCE MULTER ──────────────────────────────────────────────────────────
const upload = multer({
  storage:    localStorage,
  limits: {
    fileSize: MAX_FILE_SIZE,     // Max 10 Mo par fichier
    files:    5,                 // Max 5 fichiers par requête
    fields:   10,                // Max 10 champs non-fichier
  },
  fileFilter,
});

// ─── MIDDLEWARES EXPORTÉS ─────────────────────────────────────────────────────

// Upload d'un seul fichier (champ "file")
export const uploadSingle = upload.single("file");

// Upload de plusieurs fichiers (champ "files", max 5)
export const uploadMultiple = upload.array("files", 5);

// Upload avec champs nommés (ex: facture + pièce jointe)
export const uploadFields = upload.fields([
  { name: "document", maxCount: 1 },
  { name: "attachment", maxCount: 3 },
]);

// ─── HELPER : Supprimer un fichier local ──────────────────────────────────────
export function deleteLocalFile(filePath: string): void {
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch (err) {
    console.error("[UPLOAD] Erreur suppression fichier:", err);
  }
}

// ─── HELPER : Infos fichier normalisées ───────────────────────────────────────
export function getFileInfo(file: Express.Multer.File) {
  return {
    originalName: file.originalname,
    storedName:   file.filename,
    mimeType:     file.mimetype,
    size:         file.size,
    sizeLabel:    `${(file.size / 1024).toFixed(1)} Ko`,
    path:         file.path,
    url:          `/uploads/${file.filename}`, // URL publique locale
  };
}

// ─── INTÉGRATION S3 (production) ─────────────────────────────────────────────
// Pour passer en S3, remplacer localStorage par :
//
// import multerS3 from "multer-s3";
// import { S3Client } from "@aws-sdk/client-s3";
//
// const s3 = new S3Client({ region: "eu-west-3" }); // AWS Paris — RGPD
//
// const s3Storage = multerS3({
//   s3,
//   bucket: process.env.S3_BUCKET!,
//   acl: "private",                          // Jamais public par défaut
//   serverSideEncryption: "AES256",          // Chiffrement S3 natif
//   key: (_req, file, cb) => {
//     const randomName = crypto.randomBytes(32).toString("hex");
//     const ext = path.extname(file.originalname).toLowerCase();
//     // Organiser par org : uploads/{orgId}/{randomName}.ext
//     cb(null, `uploads/${randomName}${ext}`);
//   },
// });
//
// Puis remplacer "storage: localStorage" par "storage: s3Storage"
// et supprimer deleteLocalFile (utiliser s3.send(new DeleteObjectCommand(...)))
