import ePub from 'epubjs';
import * as pdfjs from 'pdfjs-dist';
import JSZip from 'jszip';

// PDF Worker 설정 - public 폴더에 복사된 로컬 파일 사용
pdfjs.GlobalWorkerOptions.workerSrc = '/pdf.worker.js';

export interface DocChapter {
  id: string;
  title: string;
  content: string; // HTML or Text
  type: 'html' | 'text';
}

export interface DocMetadata {
  title?: string;
  author?: string;
  cover?: string; // Data URL or URL
  toc?: { title: string; href: string; level: number }[];
}

export interface DocStructure {
  type: 'pdf' | 'epub';
  chapters: DocChapter[];
  metadata: DocMetadata;
}

export const parseEpub = async (file: File): Promise<DocStructure> => {
  console.log("Parsing EPUB start:", file.name);
  const arrayBuffer = await file.arrayBuffer();
  
  return new Promise(async (resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("EPUB 분석 타임아웃")), 60000);
    try {
      const book = ePub(arrayBuffer);
      await book.ready;
      
      const chapters: DocChapter[] = [];
      const spine = (book.spine as any);
      
      // 메타데이터 및 목차 추출
      const epubMeta = await book.loaded.metadata;
      const epubToc = await book.loaded.navigation;
      let coverUrl = await book.coverUrl();

      // 표지 추출 보강
      if (!coverUrl) {
        try {
          const spineData = book.spine as any;
          const items = spineData.items || spineData.spineItems || [];
          const coverItem = items.find((item: any) => 
            item.idref?.toLowerCase().includes('cover') || 
            (item.properties && item.properties.includes('cover-image')) ||
            item.href?.toLowerCase().includes('cover')
          );
          
          if (coverItem) {
            const rawBlob = await book.archive.getBlob(coverItem.href);
            if (rawBlob) {
              // MIME 타입 추론
              const ext = coverItem.href.split('.').pop()?.toLowerCase();
              const mime = ext === 'png' ? 'image/png' : (ext === 'webp' ? 'image/webp' : 'image/jpeg');
              const blob = new Blob([rawBlob], { type: mime });
              
              coverUrl = await new Promise((res) => {
                const r = new FileReader();
                r.onload = () => res(r.result as string);
                r.readAsDataURL(blob);
              });
            }
          }
        } catch (e) {
          console.warn("Cover extraction fallback failed:", e);
        }
      }

      // TOC를 평탄화하여 검색하기 쉽게 만듦
      const flatToc: { title: string; href: string }[] = [];
      const flattenToc = (items: any[]) => {
        for (const item of items) {
          if (!item.href) continue;
          const cleanHref = item.href.split('#')[0].replace(/^\//, '').toLowerCase();
          flatToc.push({ title: item.label, href: cleanHref });
          if (item.subitems) flattenToc(item.subitems);
        }
      };
      if (epubToc && epubToc.toc) flattenToc(epubToc.toc);

      // JSZip을 사용하여 모든 이미지 에셋 미리 로드
      const zip = await JSZip.loadAsync(file);
      const imageMap: Record<string, string> = {}; 
      
      for (const [path, zipObjRaw] of Object.entries(zip.files)) {
        const zipObj = zipObjRaw as JSZip.JSZipObject;
        if (!zipObj.dir) {
          const lowerPath = path.toLowerCase();
          if (lowerPath.match(/\.(png|jpe?g|gif|webp|svg)$/)) {
            const blob = await zipObj.async('blob');
            const dataUrl = await new Promise<string>((res) => {
              const reader = new FileReader();
              reader.onload = () => res(reader.result as string);
              reader.readAsDataURL(blob);
            });
            imageMap[lowerPath] = dataUrl;
            
            // 파일명(basename)으로도 접근 가능하게 캐싱
            const fileName = path.split('/').pop()?.toLowerCase();
            if (fileName && !imageMap[fileName]) {
               imageMap[fileName] = dataUrl;
            }
          }
        }
      }

      for (let i = 0; i < spine.length; i++) {
        const item = spine.get(i);
        if (!item || !item.href) continue;
        
        const doc = await item.load(book.load.bind(book));
        const body = doc.body || doc.querySelector('body');

        let rawHtml = body ? body.innerHTML : (doc.documentElement?.innerHTML || "");

        // ── 정규식으로 img/image 태그의 src/href/xlink:href 를 직접 치환 ──
        // epubjs item.canonical()을 쓰지 않고 수동으로 상대경로를 해석합니다.
        const itemDir = item.href.replace(/^\//, '').replace(/[^/]+$/, '').toLowerCase();

        /**
         * 상대 src를 기준으로 후보 경로 목록 생성
         */
        const resolveSrc = (src: string): string | null => {
          if (src.startsWith('data:') || src.startsWith('http') || src.startsWith('//')) return null;
          
          const fileName = src.split('/').pop()?.toLowerCase() || '';
          const srcLower = src.replace(/^[./]+/, '').toLowerCase();
          
          // 1순위: 아이템 디렉터리 기준 상대경로 해석
          const baseResolved = (itemDir + srcLower)
            .replace(/[^/]+\/\.\.\//g, '')   // ../ 제거
            .replace(/^\//,'')
            .toLowerCase();

          return imageMap[baseResolved] ||
                 imageMap[srcLower] ||
                 imageMap[fileName] ||
                 imageMap[`oebps/images/${fileName}`] ||
                 imageMap[`ops/images/${fileName}`] ||
                 imageMap[`images/${fileName}`] ||
                 imageMap[`oebps/${fileName}`] ||
                 imageMap[`ops/${fileName}`] ||
                 null;
        };

        // img 태그의 src 치환
        rawHtml = rawHtml.replace(
          /(<img\b[^>]*?\s)src=(['"])([^'"]+)\2/gi,
          (_m: string, tagPre: string, quote: string, srcVal: string) => {
            const resolved = resolveSrc(srcVal);
            return resolved ? `${tagPre}src=${quote}${resolved}${quote}` : _m;
          }
        );
        // SVG <image> 태그의 xlink:href / href 치환
        rawHtml = rawHtml.replace(
          /(<image\b[^>]*?\s)(?:xlink:href|href)=(['"])([^'"]+)\2/gi,
          (_m: string, tagPre: string, quote: string, srcVal: string) => {
            const resolved = resolveSrc(srcVal);
            return resolved
              ? `${tagPre}xlink:href=${quote}${resolved}${quote} href=${quote}${resolved}${quote}`
              : _m;
          }
        );


        // TOC에서 제목 찾기 (더 유연하게)
        const itemHref = item.href.replace(/^\//, '').toLowerCase();
        const itemBasename = itemHref.split('/').pop()?.toLowerCase() || "";

        const tocMatch = flatToc.find(t => 
          itemHref.includes(t.href) || 
          t.href.includes(itemHref) ||
          (itemBasename && t.href.includes(itemBasename))
        );
        const title = tocMatch?.title || item.idref || `Chapter ${i+1}`;
        
        // rawHtml에 이미 이미지 src가 Data URL로 치환되어 있음
        chapters.push({
          id: item.href,
          title: title,
          content: rawHtml,
          type: 'html'
        });
        
        item.unload();
      }
      
      clearTimeout(timeout);
      resolve({ 
        type: 'epub', 
        chapters,
        metadata: {
          title: epubMeta.title,
          author: epubMeta.creator,
          cover: coverUrl || undefined,
          toc: epubToc.toc.map((t: any) => ({ title: t.label, href: t.href, level: 0 }))
        }
      });
    } catch (error) {
      clearTimeout(timeout);
      reject(error);
    }
  });
};

export const parsePdf = async (file: File): Promise<DocStructure> => {
  console.log("Parsing PDF:", file.name);
  const arrayBuffer = await file.arrayBuffer();
  const pdf = await pdfjs.getDocument({ data: arrayBuffer }).promise;
  const chapters: DocChapter[] = [];

  // PDF 메타데이터 및 아웃라인 추출
  const pdfMeta = await pdf.getMetadata();
  const outline = await pdf.getOutline();

  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    const text = content.items.map((item: any) => item.str).join(' ');
    
    chapters.push({
      id: `page-${i}`,
      title: `Page ${i}`,
      content: text,
      type: 'text'
    });
  }
  
  return { 
    type: 'pdf', 
    chapters,
    metadata: {
      title: (pdfMeta.info as any)?.Title || file.name,
      author: (pdfMeta.info as any)?.Author,
      toc: outline?.map((o: any) => ({ title: o.title, href: `page-${o.dest}`, level: 0 }))
    }
  };
};
