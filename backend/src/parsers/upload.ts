import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, extname } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function getFileExtension(filename: string): string {
  return extname(filename).toLowerCase();
}

export function isPdfUpload(filename: string, mimeType: string): boolean {
  return getFileExtension(filename) === ".pdf" || mimeType === "application/pdf";
}

export async function extractTextFromUploadedFile(file: {
  originalname: string;
  mimetype: string;
  buffer: Buffer;
}): Promise<string> {
  if (!file.buffer || file.buffer.length === 0) {
    throw new Error("Uploaded file is empty");
  }

  if (!isPdfUpload(file.originalname, file.mimetype)) {
    return file.buffer.toString("utf8");
  }

  const workingDir = await mkdtemp(join(tmpdir(), "cmc-upload-"));
  const inputPath = join(workingDir, file.originalname || "upload.pdf");

  try {
    await writeFile(inputPath, file.buffer);

    const { stdout } = await execFileAsync("pdftotext", ["-layout", inputPath, "-"], {
      maxBuffer: 10 * 1024 * 1024,
    });

    return stdout;
  } catch {
    throw new Error(
      "Failed to extract text from uploaded PDF. Ensure pdftotext is installed and the file is a valid PDF."
    );
  } finally {
    await rm(workingDir, { recursive: true, force: true });
  }
}