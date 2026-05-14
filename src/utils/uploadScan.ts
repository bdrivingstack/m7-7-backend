import multer from "multer";

export const scanUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    files: 10,
    fileSize: 15 * 1024 * 1024,
  },
  fileFilter: (_req, file, cb) => {
    const allowed = [
      "image/jpeg",
      "image/png",
      "image/webp",
      "application/pdf",
    ];

    if (!allowed.includes(file.mimetype)) {
      cb(new Error("Format non supporté. Utilisez JPG, PNG, WEBP ou PDF."));
      return;
    }

    cb(null, true);
  },
});
