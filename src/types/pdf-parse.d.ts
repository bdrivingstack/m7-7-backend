declare module "pdf-parse" {
  function pdfParse(
    dataBuffer: Buffer,
    options?: {
      pagerender?: (pageData: any) => string | Promise<string>;
      max?: number;
      version?: string;
    }
  ): Promise<{
    numpages: number;
    numrender: number;
    info: any;
    metadata: any;
    version: string;
    text: string;
  }>;
  export = pdfParse;
}

declare module "pdf-parse/lib/pdf-parse.js" {
  function pdfParse(
    dataBuffer: Buffer,
    options?: {
      pagerender?: (pageData: any) => string | Promise<string>;
      max?: number;
      version?: string;
    }
  ): Promise<{
    numpages: number;
    numrender: number;
    info: any;
    metadata: any;
    version: string;
    text: string;
  }>;
  export = pdfParse;
}
