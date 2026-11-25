import fs from "node:fs";
import path from "node:path";

export interface KnowledgeDoc {
  ref: string;
  kind: "revit-howto" | "standard-reference" | "domain-rule";
  title: string;
  regionProfile?: string;
  relatedTools: string[];
  summary: string;
  body: string;
}

export class KnowledgeBase {
  private readonly docs = new Map<string, KnowledgeDoc>();

  constructor(private readonly knowledgeDir: string) {
    this.reload();
  }

  reload(): void {
    this.docs.clear();
    if (!fs.existsSync(this.knowledgeDir)) return;

    for (const file of fs.readdirSync(this.knowledgeDir)) {
      if (!file.endsWith(".json")) continue;
      try {
        const raw = fs.readFileSync(path.join(this.knowledgeDir, file), "utf8");
        const parsed = JSON.parse(raw) as KnowledgeDoc | KnowledgeDoc[];
        const list = Array.isArray(parsed) ? parsed : [parsed];
        for (const doc of list) {
          if (doc.ref) this.docs.set(doc.ref, doc);
        }
      } catch (err) {
        console.warn(`[knowledge] Failed to load ${file}:`, err);
      }
    }
  }

  get(ref: string): KnowledgeDoc | undefined {
    return this.docs.get(ref);
  }

  search(query: string, regionProfile?: string, limit = 5): KnowledgeDoc[] {
    const terms = query
      .toLowerCase()
      .split(/\s+/)
      .filter((t) => t.length >= 2);

    const scored: Array<{ doc: KnowledgeDoc; score: number }> = [];
    for (const doc of this.docs.values()) {
      if (regionProfile && doc.regionProfile && doc.regionProfile !== regionProfile) {
        continue;
      }
      const haystack = `${doc.title} ${doc.summary} ${doc.body} ${doc.relatedTools.join(" ")}`.toLowerCase();
      let score = 0;
      for (const term of terms) {
        if (haystack.includes(term)) score += 1;
      }
      if (score > 0) scored.push({ doc, score });
    }

    return scored
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((s) => s.doc);
  }
}
