export type ScanAiResponse = {
  ok: boolean;
  document_type: string;
  ocr_text: string;
  ocr_confidence: number;
  extracted: {
    merchant?: string | null;
    date?: string | null;
    amount_ttc?: number | null;
    amount_ht?: number | null;
    vat_amount?: number | null;
    vat_rate?: number | null;
    currency: string;
  };
  pages: Array<{
    page_index: number;
    quality_score: number;
    blur_score: number;
    brightness: number;
    cropped: boolean;
    rotation_applied: number;
    warning?: string | null;
  }>;
  cleaned_images: string[];
  pdf_base64: string;
  warnings: string[];
};

const SCAN_AI_URL = process.env.SCAN_AI_URL ?? "http://localhost:8010";

export async function callScanAi(files: Express.Multer.File[]): Promise<ScanAiResponse> {
  const formData = new FormData();

  for (const file of files) {
    const blob = new Blob([new Uint8Array(file.buffer)], { type: file.mimetype || "image/jpeg" });
    formData.append("files", blob, file.originalname || "scan.jpg");
  }

  const res = await fetch(`${SCAN_AI_URL}/scan`, {
    method: "POST",
    body: formData,
  });

  const json = await res.json().catch(() => null);

  if (!res.ok) {
    throw new Error(json?.detail || json?.message || "Analyse du scan impossible");
  }

  return json as ScanAiResponse;
}
