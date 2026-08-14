import { listAllKnowledge } from "./knowledge-store.js";
import type { Insight } from "./knowledge-store.js";

export interface KnowledgeSearchHit {
  kind: "project" | "insight";
  projectName: string;
  projectPath: string;
  projectUpdatedAt: string;
  insight?: Insight;
  matchedFields: string[];
  score: number;
}

const CATEGORY_LABELS: Record<string, string> = {
  architecture: "架构设计",
  feature: "功能实现",
  pattern: "设计模式",
  api: "API接口",
  data_flow: "数据流",
  bug_fix: "Bug修复",
  performance: "性能优化",
  config: "配置相关",
  dependency: "依赖相关",
  other: "其他",
};

interface SearchField {
  label: string;
  value: string;
}

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\s_\-.,/\\()（）:：;；!！?？]+/g, "");
}

function queryTokens(query: string): string[] {
  return query.trim().toLowerCase().split(/\s+/).filter(Boolean);
}

function fuzzyScore(token: string, text: string): number {
  const q = normalize(token);
  const t = normalize(text);
  if (!q || !t) return 0;

  const exactIndex = t.indexOf(q);
  if (exactIndex >= 0) {
    return 100 + Math.min(20, Math.max(0, 80 - exactIndex));
  }

  let cursor = 0;
  let hitCount = 0;
  for (const ch of q) {
    const index = t.indexOf(ch, cursor);
    if (index === -1) return 0;
    hitCount++;
    cursor = index + 1;
  }

  const coverage = hitCount / q.length;
  const proximity = Math.max(0, 1 - cursor / Math.max(t.length, 1));
  return Math.round(30 + coverage * 50 + proximity * 20);
}

function matchFields(query: string, fields: SearchField[]): {
  score: number;
  matchedFields: string[];
} | null {
  const tokens = queryTokens(query);
  if (tokens.length === 0) return null;

  let totalScore = 0;
  const matched = new Set<string>();

  for (const token of tokens) {
    let bestScore = 0;
    let bestLabel = "";

    for (const field of fields) {
      const score = fuzzyScore(token, field.value);
      if (score > bestScore) {
        bestScore = score;
        bestLabel = field.label;
      }
    }

    if (bestScore === 0) return null;
    totalScore += bestScore;
    if (bestLabel) matched.add(bestLabel);
  }

  return {
    score: Math.round(totalScore / tokens.length),
    matchedFields: Array.from(matched),
  };
}

function insightFields(insight: Insight): SearchField[] {
  const fields: SearchField[] = [
    { label: "问题", value: insight.question },
    { label: "答案", value: insight.answer },
    { label: "标签", value: insight.tags.join(" ") },
    {
      label: "分类",
      value: `${CATEGORY_LABELS[insight.category] || insight.category} ${insight.category}`,
    },
  ];

  if (insight.relatedSymbols?.length) {
    fields.push({ label: "符号", value: insight.relatedSymbols.join(" ") });
  }
  if (insight.relatedModules?.length) {
    fields.push({ label: "模块", value: insight.relatedModules.join(" ") });
  }
  if (insight.relatedApis?.length) {
    fields.push({ label: "API", value: insight.relatedApis.join(" ") });
  }
  if (insight.relatedFiles?.length) {
    fields.push({ label: "文件", value: insight.relatedFiles.join(" ") });
  }

  return fields;
}

export function searchKnowledge(
  query: string,
  limit = 200
): KnowledgeSearchHit[] {
  const hits: KnowledgeSearchHit[] = [];

  for (const knowledge of listAllKnowledge()) {
    const projectMatch = matchFields(query, [
      { label: "项目名称", value: knowledge.name },
      { label: "业务总结", value: knowledge.businessSummary },
    ]);

    if (projectMatch) {
      hits.push({
        kind: "project",
        projectName: knowledge.name,
        projectPath: knowledge.projectPath,
        projectUpdatedAt: knowledge.lastUpdated,
        matchedFields: projectMatch.matchedFields,
        score: projectMatch.score,
      });
    }

    for (const insight of knowledge.insights) {
      const match = matchFields(query, insightFields(insight));
      if (!match) continue;

      hits.push({
        kind: "insight",
        projectName: knowledge.name,
        projectPath: knowledge.projectPath,
        projectUpdatedAt: knowledge.lastUpdated,
        insight,
        matchedFields: match.matchedFields,
        score: match.score,
      });
    }
  }

  return hits
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}
