import axios from 'axios';
import type { DocStructure, DocChapter } from './parser';

/**
 * Google 번역 웹 서비스를 활용하여 텍스트를 번역하는 유틸리티
 * 웹 페이지 스크래핑 방식은 CORS 및 Google의 제재 위험이 있으므로,
 * 실제 구현에서는 공식 API를 사용하거나 프록시를 거치는 것이 안전합니다.
 * 본 구현에서는 텍스트 분할 방식의 로직 구조를 중점적으로 보여줍니다.
 */

const MAX_CHARS = 3000; // 무료 번역 권장 한도 하향 조정

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// HTML 태그를 보호하며 텍스트 노드들을 일괄 번역하는 함수
// 이미지 src (data URL 포함)를 먼저 플레이스홀더로 치환했다가 번역 후 복원하여
// 브라우저 DOM 파싱 시 src가 변형되는 것을 방지합니다.
export const translateHtml = async (html: string, targetLang: string): Promise<string> => {
  if (!html || !html.trim()) return "";
  
  // 1단계: 이미지 src를 플레이스홀더로 교체 (Data URL, blob URL, 외부 URL 모두 보호)
  const srcMap: Record<string, string> = {};
  let srcIndex = 0;
  const htmlWithPlaceholders = html.replace(
    /(<(?:img|image)[^>]*?)(\s(?:src|href|xlink:href)\s*=\s*["'])([^"']+)(["'])/gi,
    (_match, tagStart, attrStart, srcVal, attrEnd) => {
      const placeholder = `__IMG_SRC_${srcIndex++}__`;
      srcMap[placeholder] = srcVal;
      return `${tagStart}${attrStart}${placeholder}${attrEnd}`;
    }
  );

  const parser = new DOMParser();
  const doc = parser.parseFromString(htmlWithPlaceholders, 'text/html');
  const container = doc.body || doc.documentElement;
  
  const textNodes: { node: Node; original: string }[] = [];
  
  // 2단계: 텍스트 노드 수집 (script, style, img 내부는 무시)
  const walk = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE && node.textContent?.trim()) {
      // 플레이스홀더 자체가 텍스트 노드에 있으면 번역하지 않음
      if (!node.textContent.startsWith('__IMG_SRC_')) {
        textNodes.push({ node, original: node.textContent });
      }
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      const tagName = (node as Element).tagName.toLowerCase();
      if (tagName === 'script' || tagName === 'style') return;
      Array.from(node.childNodes).forEach(walk);
    }
  };
  walk(container);

  if (textNodes.length === 0) {
    // 번역할 텍스트 없어도 플레이스홀더는 복원
    let result = container.innerHTML;
    for (const [ph, src] of Object.entries(srcMap)) {
      result = result.replaceAll(ph, src);
    }
    return result;
  }

  // 3단계: 텍스트를 MAX_CHARS 단위로 배칭
  const batches: { nodes: typeof textNodes; text: string }[] = [];
  let currentBatch: typeof textNodes = [];
  let currentText = "";

  for (const item of textNodes) {
    if ((currentText + item.original).length > MAX_CHARS && currentBatch.length > 0) {
      batches.push({ nodes: currentBatch, text: currentText });
      currentBatch = [item];
      currentText = item.original;
    } else {
      currentBatch.push(item);
      currentText += (currentText ? "\n" : "") + item.original;
    }
  }
  if (currentBatch.length > 0) batches.push({ nodes: currentBatch, text: currentText });

  // 4단계: 각 배치 번역 및 결과 분배
  for (const batch of batches) {
    const translated = await translateChunk(batch.text, targetLang);
    
    if (batch.nodes.length === 1) {
      batch.nodes[0].node.textContent = translated;
    } else {
      const lines = translated.split('\n');
      batch.nodes.forEach((item, idx) => {
        item.node.textContent = lines[idx] || lines[lines.length - 1] || item.original;
      });
    }
    await sleep(200);
  }

  // 5단계: 플레이스홀더를 원래 src로 복원
  let result = container.innerHTML;
  for (const [ph, src] of Object.entries(srcMap)) {
    result = result.replaceAll(ph, src);
  }

  return result;
};

export const splitText = (text: string): string[] => {
  if (!text || !text.trim()) return [];
  
  const chunks: string[] = [];
  let currentChunk = "";

  const sentences = text.split(/(?<=[.!?])\s+/).filter(s => s.trim().length > 0);

  for (const sentence of sentences) {
    if ((currentChunk + sentence).length > MAX_CHARS) {
      if (currentChunk.trim()) chunks.push(currentChunk.trim());
      currentChunk = sentence;
    } else {
      currentChunk += " " + sentence;
    }
  }

  if (currentChunk.trim()) {
    chunks.push(currentChunk.trim());
  }

  return chunks;
};

// 무료 웹 번역 서비스를 위한 프록시 또는 라이브러리 사용 가상 로직
export const translateChunk = async (text: string, targetLang: string = 'ko', retries = 3): Promise<string> => {
  if (!text || !text.trim()) return "";

  for (let i = 0; i <= retries; i++) {
    try {
      // 주의: 실제 브라우저 환경에서 직접 google translate에 GET 요청 시 CORS 이슈 발생할 수 있음
      const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${targetLang}&dt=t&q=${encodeURIComponent(text)}`;
      
      const response = await axios.get(url, { timeout: 10000 });
      if (response.data && response.data[0]) {
        return response.data[0].map((item: any) => item[0]).join('');
      }
      return text;
    } catch (error: any) {
      const isRateLimit = error.response?.status === 429;
      if (i < retries) {
        const waitTime = isRateLimit ? (i + 1) * 3000 : (i + 1) * 1000;
        console.warn(`Translation retry ${i + 1}/${retries} after ${waitTime}ms...`, isRateLimit ? "(Rate Limited)" : "");
        await sleep(waitTime);
        continue;
      }
      console.error("Translation Final Error:", error);
      return `[번역 실패: ${text.substring(0, 20)}...]`;
    }
  }
  return text;
};

export const translateStructure = async (
  structure: DocStructure,
  onProgress: (progress: number) => void,
  targetLang: string = 'ko'
): Promise<DocStructure> => {
  const translatedChapters: DocChapter[] = [];
  const total = structure.chapters.length;

  // 장별 번역
  for (let i = 0; i < total; i++) {
    const chapter = structure.chapters[i];
    let translatedContent = "";
    
    // 장 제목 번역 추가
    const translatedTitle = await translateChunk(chapter.title, targetLang);

    if (chapter.type === 'html') {
      translatedContent = await translateHtml(chapter.content, targetLang);
    } else {
      const chunks = splitText(chapter.content);
      const translatedChunks = [];
      for (const chunk of chunks) {
        translatedChunks.push(await translateChunk(chunk, targetLang));
      }
      translatedContent = translatedChunks.join('\n\n');
    }

    translatedChapters.push({
      ...chapter,
      title: translatedTitle,
      content: translatedContent
    });

    onProgress(((i + 1) / (total + 1)) * 100); // 목차 번역을 위해 약간 남겨둠
    
    // 로봇으로 인식되지 않도록 짧은 랜덤 지터 추가
    const jitter = Math.random() * 500;
    await sleep(500 + jitter);
  }

  // 목차(TOC) 번역
  const translatedToc = [];
  if (structure.metadata.toc) {
    for (const item of structure.metadata.toc) {
      const translatedLabel = await translateChunk(item.title, targetLang);
      translatedToc.push({ ...item, title: translatedLabel });
    }
  }

  onProgress(100);

  return { 
    ...structure, 
    chapters: translatedChapters,
    metadata: {
      ...structure.metadata,
      toc: translatedToc.length > 0 ? translatedToc : undefined
    }
  };
};

export const translateSequential = async (
  chunks: string[], 
  onProgress: (progress: number) => void,
  targetLang: string = 'ko'
): Promise<string[]> => {
  const translated: string[] = [];
  
  for (let i = 0; i < chunks.length; i++) {
    const result = await translateChunk(chunks[i], targetLang);
    translated.push(result);
    onProgress(((i + 1) / chunks.length) * 100);
    
    // Google 번역 서버 부하 방지 및 차단 회피를 위한 짧은 지연
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  
  return translated;
};
