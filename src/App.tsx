import React, { useState, useEffect, useRef, useCallback } from 'react';
import { 
  Upload, 
  Languages, 
  Volume2, 
  Download,
  LogIn,
  X,
  FileText,
  Loader2,
  Pause,
  Settings,
  ChevronDown,
  ChevronUp
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { parseEpub, parsePdf, type DocStructure } from './utils/parser';
import { translateStructure, translateChunk } from './utils/translator';
import { auth, signInWithGoogle, logout } from './lib/firebase';
import { onAuthStateChanged, type User } from 'firebase/auth';
import JSZip from 'jszip';
import { jsPDF } from 'jspdf';

const App: React.FC = () => {
  const [user, setUser] = useState<User | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [status, setStatus] = useState<'idle' | 'parsing' | 'ready' | 'translating' | 'viewing'>('idle');
  const [targetLang, setTargetLang] = useState('ko');
  const [outputFormat, setOutputFormat] = useState<'pdf' | 'epub' | 'txt'>('pdf');
  const [progress, setProgress] = useState(0);
  const [docStructure, setDocStructure] = useState<DocStructure | null>(null);
  const [translatedStructure, setTranslatedStructure] = useState<DocStructure | null>(null);
  const [translatedFileName, setTranslatedFileName] = useState<string>("");
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [viewMode, setViewMode] = useState<'layout' | 'text'>('text'); 
  const [displayMode, setDisplayMode] = useState<'translated' | 'original' | 'dual'>('translated');

  // TTS 설정
  const [ttsEngine, setTtsEngine] = useState<'browser' | 'gemini'>('browser');
  const [ttsVoices, setTtsVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [ttsVoiceURI, setTtsVoiceURI] = useState<string>('');
  const [ttsRate, setTtsRate] = useState(1.0);
  const [ttsPitch, setTtsPitch] = useState(1.0);
  const [ttsVolume, setTtsVolume] = useState(1.0);
  const [geminiApiKey, setGeminiApiKey] = useState('');
  const [showTtsPanel, setShowTtsPanel] = useState(false);
  const ttsAudioRef = useRef<HTMLAudioElement | null>(null);
  const utteranceRef = useRef<SpeechSynthesisUtterance | null>(null);

  // 브라우저 TTS 음성 목록 로드 (Natural Voice 우선 정렬)
  useEffect(() => {
    const loadVoices = () => {
      const voices = window.speechSynthesis.getVoices();
      if (voices.length === 0) return;
      // Natural/Online 음성을 우선으로 정렬
      const sorted = [...voices].sort((a, b) => {
        const aNatural = a.name.toLowerCase().includes('natural') || a.name.toLowerCase().includes('online') || !a.localService;
        const bNatural = b.name.toLowerCase().includes('natural') || b.name.toLowerCase().includes('online') || !b.localService;
        if (aNatural && !bNatural) return -1;
        if (!aNatural && bNatural) return 1;
        return 0;
      });
      setTtsVoices(sorted);
      // 현재 언어에 맞는 Natural 음성 기본 선택
      const langMap: Record<string, string> = {
        'ko': 'ko', 'en': 'en', 'ja': 'ja', 'zh': 'zh', 'es': 'es'
      };
      const langCode = langMap[targetLang] || 'ko';
      const natural = sorted.find(v =>
        v.lang.toLowerCase().startsWith(langCode) &&
        (v.name.toLowerCase().includes('natural') || v.name.toLowerCase().includes('online') || !v.localService)
      ) || sorted.find(v => v.lang.toLowerCase().startsWith(langCode));
      if (natural) setTtsVoiceURI(natural.voiceURI);
    };
    loadVoices();
    window.speechSynthesis.onvoiceschanged = loadVoices;
  }, [targetLang]);

  useEffect(() => {
    if (!auth) return;
    const unsubscribe = onAuthStateChanged(auth, (currentUser) => {
      setUser(currentUser);
    });
    return () => unsubscribe();
  }, []);

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const uploadedFile = e.target.files?.[0];
    if (!uploadedFile) return;
    setFile(uploadedFile);
    setStatus('parsing');

    try {
      let structure: DocStructure;
      const fileName = uploadedFile.name.toLowerCase();
      if (fileName.endsWith('.epub')) {
        structure = await parseEpub(uploadedFile);
        setOutputFormat('epub');
      } else if (fileName.endsWith('.pdf')) {
        structure = await parsePdf(uploadedFile);
        setOutputFormat('pdf');
      } else {
        throw new Error("지원하지 않는 파일 형식입니다.");
      }
      
      if (structure.chapters.length === 0) {
        throw new Error("문서에서 추출할 수 있는 내용이 없습니다.");
      }

      setDocStructure(structure);
      setStatus('ready');
    } catch (error: any) {
      console.error("Process Error:", error);
      alert(`파일 처리 중 오류가 발생했습니다: ${error.message || error}`);
      setStatus('idle');
    }
  };

  const startTranslation = async () => {
    if (!docStructure) return;
    setStatus('translating');
    setProgress(0);
    try {
      // 파일명 번역
      const baseName = file?.name.replace(/\.[^/.]+$/, "") || "document";
      const tName = await translateChunk(baseName, targetLang);
      setTranslatedFileName(tName);

      const translated = await translateStructure(docStructure, (p) => setProgress(p), targetLang);
      setTranslatedStructure(translated);
      setStatus('viewing');
    } catch (error: any) {
      console.error("Translation Error:", error);
      alert(`번역 중 오류가 발생했습니다: ${error.message || error}`);
      setStatus('ready');
    }
  };

  // 브라우저 Web Speech API TTS
  const handleBrowserTTS = useCallback((text: string) => {
    if (isSpeaking) {
      window.speechSynthesis.cancel();
      setIsSpeaking(false);
      return;
    }
    const utterance = new SpeechSynthesisUtterance(text);
    const langMap: Record<string, string> = {
      'ko': 'ko-KR', 'en': 'en-US', 'ja': 'ja-JP', 'zh': 'zh-CN', 'es': 'es-ES'
    };
    utterance.lang = langMap[targetLang] || 'ko-KR';
    utterance.rate = ttsRate;
    utterance.pitch = ttsPitch;
    utterance.volume = ttsVolume;
    const voice = ttsVoices.find(v => v.voiceURI === ttsVoiceURI);
    if (voice) utterance.voice = voice;
    utterance.onend = () => setIsSpeaking(false);
    utterance.onerror = () => setIsSpeaking(false);
    utteranceRef.current = utterance;
    window.speechSynthesis.speak(utterance);
    setIsSpeaking(true);
  }, [isSpeaking, targetLang, ttsRate, ttsPitch, ttsVolume, ttsVoiceURI, ttsVoices]);

  // Gemini TTS (gemini-2.5-flash-preview-tts)
  const handleGeminiTTS = useCallback(async (text: string) => {
    if (isSpeaking) {
      ttsAudioRef.current?.pause();
      setIsSpeaking(false);
      return;
    }
    if (!geminiApiKey) {
      alert('Gemini API 키를 입력해주세요.');
      return;
    }
    try {
      setIsSpeaking(true);
      const langStyleMap: Record<string, string> = {
        'ko': '한국어로 자연스럽게 읽어주세요.', 'en': 'Read naturally in English.',
        'ja': '日本語で自然に読んでください。', 'zh': '请用中文自然地朗读。', 'es': 'Lee naturalmente en español.'
      };
      const systemPrompt = langStyleMap[targetLang] || langStyleMap['ko'];
      // 텍스트를 최대 2000자로 제한 (API 제한)
      const limitedText = text.replace(/<[^>]*>/gm, '').substring(0, 2000);

      const textWithPrompt = `${systemPrompt}\n\n${limitedText}`;

      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-tts:generateContent?key=${geminiApiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: textWithPrompt }] }],
            generationConfig: {
              responseModalities: ['AUDIO'],
              speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Aoede' } } }
            }
          })
        }
      );
      
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        console.error("Gemini API Error Response:", errData);
        throw new Error(`Gemini TTS 오류: ${res.status} - ${errData.error?.message || '알 수 없는 오류'}`);
      }
      
      const data = await res.json();
      const b64Audio = data?.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
      if (!b64Audio) {
        console.error("Gemini Response Data:", data);
        throw new Error('Gemini TTS 응답에 오디오 데이터가 없습니다');
      }

      const binary = atob(b64Audio);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      const audioBlob = new Blob([bytes], { type: 'audio/wav' });
      const audioUrl = URL.createObjectURL(audioBlob);

      const audio = new Audio(audioUrl);
      ttsAudioRef.current = audio;
      audio.playbackRate = ttsRate;
      audio.onended = () => { setIsSpeaking(false); URL.revokeObjectURL(audioUrl); };
      audio.onerror = () => { setIsSpeaking(false); URL.revokeObjectURL(audioUrl); };
      audio.play();
    } catch (e: any) {
      console.error('Gemini TTS Error:', e);
      alert(`${e.message}`);
      setIsSpeaking(false);
    }
  }, [isSpeaking, targetLang, ttsRate, geminiApiKey]);

  const handleTTS = useCallback((text: string) => {
    if (ttsEngine === 'gemini') handleGeminiTTS(text);
    else handleBrowserTTS(text);
  }, [ttsEngine, handleBrowserTTS, handleGeminiTTS]);


  // 폰트 파일 로드 헬퍼 (재시도 및 에러 처리 강화)
  const fetchFontBase64 = async (url: string) => {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Font fetch failed: ${response.status}`);
    const blob = await response.blob();
    return new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = reader.result as string;
        resolve(result.split(',')[1]);
      };
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  };

  // 한글 폰트 로드 및 jsPDF 적용
  const applyFont = async (doc: any) => {
    try {
      console.log("Loading Local NanumGothic font...");
      const fontUrl = `${window.location.origin}/fonts/NanumGothic-Regular.ttf`;
      
      let base64 = "";
      try {
        const response = await fetch(fontUrl);
        if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
        const blob = await response.blob();
        base64 = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve((reader.result as string).split(',')[1]);
          reader.onerror = reject;
          reader.readAsDataURL(blob);
        });
      } catch (err) {
        console.warn(`Local font load failed, trying fetchFontBase64:`, err);
        base64 = await fetchFontBase64(fontUrl);
      }

      if (!base64 || base64.length < 1000) {
        throw new Error(`Invalid font data.`);
      }

      const fontName = 'NanumGothic';
      const fileName = 'NanumGothic-Regular.ttf';
      
      // VFS에 폰트 추가 및 스타일 등록 (bold 중복 등록 제거 - jsPDF 인코딩 오류 방지)
      doc.addFileToVFS(fileName, base64);
      doc.addFont(fileName, fontName, 'normal');
      
      // 기본 폰트 강제 설정
      doc.setFont(fontName, 'normal');
      
      console.log(`Font added as ${fontName} (normal/bold)`);
      return true;
    } catch (e) {
      console.error("Font loading failure:", e);
      return false;
    }
  };

  const downloadFile = async () => {
    if (!translatedStructure || !file) return;

    try {
      console.log("Starting definitive download process...");
      let blob: Blob;
      let mimeType: string;
      
      // 1. 파일명 생성 (유니코드 지원 및 운영체제별 금지 문자 제거)
      const sanitizeFilename = (name: string) => {
        if (!name) return "";
        return name
          .normalize('NFC')                      // 유니코드 정규화 (자소 분리 방지)
          .replace(/[\\/:*?"<>|]/g, '_')         // 금지 문자 교체
          .replace(/[\x00-\x1f\x7f]/g, '')      // 제어 문자 제거
          .replace(/^\.+/, '')                  // 점 시작 방지
          .replace(/\s+/g, ' ')                 // 중복 공백 제거
          .trim();
      };

      const rawBaseName = translatedFileName || file?.name.replace(/\.[^/.]+$/, "") || "translated_document";
      let baseName = sanitizeFilename(rawBaseName) || "translated_document";
      
      const extension = `.${outputFormat}`;
      // 확장자가 중복으로 붙지 않도록 확인 후 추가
      const downloadName = baseName.toLowerCase().endsWith(extension) ? baseName : `${baseName}${extension}`;

      console.log("Download Name (Normalized):", downloadName);

      if (outputFormat === 'epub' && docStructure?.type === 'epub') {
        mimeType = "application/epub+zip";
        const zip = await JSZip.loadAsync(file);

        // Data URL → 이진 이미지 파일로 추출하여 ZIP에 저장 (파일 크기 최적화)
        // imageDataMap: dataUrl → epub 내 상대경로 (e.g. "../Images/img001.jpeg")
        const imageDataMap = new Map<string, string>();
        let imgFileIdx = 0;

        // 이미지 폴더 결정: 원본 ZIP에서 이미지 파일 경로 패턴 찾기
        let imgFolderPrefix = 'OEBPS/Images/';
        for (const p of Object.keys(zip.files)) {
          if (p.match(/\.(png|jpe?g|gif|webp)$/i) && !zip.files[p].dir) {
            imgFolderPrefix = p.replace(/[^/]+$/, '');
            break;
          }
        }

        const dataUrlToMime: Record<string, string> = {
          'png': 'image/png', 'jpeg': 'image/jpeg', 'jpg': 'image/jpeg',
          'gif': 'image/gif', 'webp': 'image/webp', 'svg': 'image/svg+xml'
        };

        /**
         * 챕터 HTML에서 Data URL을 추출하여 ZIP 이미지 파일로 저장하고,
         * HTML 내 src를 상대경로로 교체한 뒤 반환합니다.
         */
        const processChapterHtml = async (html: string, chapPath: string): Promise<string> => {
          // 챕터 경로의 디렉터리 (XHTML 상대경로 계산 기준)
          const chapDir = chapPath.replace(/[^/]+$/, '');

          return html.replace(
            /src="(data:image\/([\w+]+);base64,([^"]+))"/gi,
            (_match: string, dataUrl: string, ext: string, b64: string) => {
              if (imageDataMap.has(dataUrl)) {
                const relPath = imageDataMap.get(dataUrl)!;
                return `src="${relPath}"`;
              }

              const safeExt = ext === 'svg+xml' ? 'svg' : ext.toLowerCase();
              const fileName = `translated_img_${String(imgFileIdx++).padStart(4, '0')}.${safeExt}`;
              const fullZipPath = `${imgFolderPrefix}${fileName}`;

              // base64 → Uint8Array → ZIP에 저장
              try {
                const binaryStr = atob(b64);
                const bytes = new Uint8Array(binaryStr.length);
                for (let k = 0; k < binaryStr.length; k++) bytes[k] = binaryStr.charCodeAt(k);
                zip.file(fullZipPath, bytes, { binary: true });

                // content.opf manifest에 추가하기 위해 기록
                const mime = dataUrlToMime[safeExt] || 'image/jpeg';
                const id = `trans-img-${imgFileIdx - 1}`;
                // OPF에 미디어 추가 (나중에 처리)
                epubManifestAdditions.push({ id, href: `${imgFolderPrefix.replace(/^OEBPS\//, '')}${fileName}`, mime });
              } catch (_e) {
                // base64 디코딩 실패 → 빈 src
              }

              // 챕터 파일에서 이미지로의 상대경로 계산
              const relPath = fullZipPath.replace(chapDir, '');
              imageDataMap.set(dataUrl, relPath);
              return `src="${relPath}"`;
            }
          );
        };

        const epubManifestAdditions: { id: string; href: string; mime: string }[] = [];

        for (const chap of translatedStructure.chapters) {
          const possiblePaths = [chap.id, `OEBPS/${chap.id}`, `OPS/${chap.id}`, chap.id.replace(/^\//, '')];
          for (const p of possiblePaths) {
            if (zip.file(p)) {
              const processedHtml = await processChapterHtml(chap.content, p);
              zip.file(p, processedHtml);
              break;
            }
          }
        }

        // content.opf에 새 이미지 항목 추가
        if (epubManifestAdditions.length > 0) {
          for (const opfPath of Object.keys(zip.files)) {
            if (opfPath.endsWith('.opf')) {
              const opfContent = await zip.file(opfPath)!.async('string');
              const additions = epubManifestAdditions
                .map(({ id, href, mime }) => `<item id="${id}" href="${href}" media-type="${mime}"/>`)
                .join('\n  ');
              const updated = opfContent.replace('<manifest>', `<manifest>\n  ${additions}`);
              zip.file(opfPath, updated);
              break;
            }
          }
        }

        // 목차 파일 (nav.xhtml, toc.ncx) 번역 업데이트
        if (translatedStructure.metadata.toc) {
          for (const fileName in zip.files) {
            const fileObj = zip.file(fileName);
            if (!fileObj) continue;
            
            const lowerName = fileName.toLowerCase();
            if (lowerName.endsWith('.ncx') || lowerName.endsWith('.xhtml') || lowerName.endsWith('.html')) {
              let content = await fileObj.async("string");
              let modified = false;

              if (lowerName.endsWith('.ncx')) {
                for (const item of translatedStructure.metadata.toc) {
                  const itemBasename = item.href.split('/').pop()?.split('#')[0];
                  const regex = new RegExp(`(<navPoint[^>]*src="[^"]*${itemBasename}[^"]*"[^>]*>[\\s\\S]*?<text>)([\\s\\S]*?)(</text>)`, 'gi');
                  if (regex.test(content)) {
                    content = content.replace(regex, `$1${item.title}$3`);
                    modified = true;
                  }
                }
              } else if (content.includes('<nav') || content.includes('epub:type="toc"')) {
                for (const item of translatedStructure.metadata.toc) {
                  const itemBasename = item.href.split('/').pop()?.split('#')[0];
                  const regex = new RegExp(`(<a[^>]*href="[^"]*${itemBasename}[^"]*"[^>]*>)([\\s\\S]*?)(</a>)`, 'gi');
                  if (regex.test(content)) {
                    content = content.replace(regex, `$1${item.title}$3`);
                    modified = true;
                  }
                }
              }

              if (modified) zip.file(fileName, content);
            }
          }
        }
        blob = await zip.generateAsync({ type: "blob" });
        // Blob의 MIME 타입 명시 (JSZip generateAsync는 mimeType 내부 지원 안 함)
        blob = new Blob([blob], { type: mimeType });
      } else if (outputFormat === 'epub') {
        mimeType = "application/epub+zip";
        const zip = new JSZip();
        zip.file("mimetype", mimeType, { compression: "STORE" });
        zip.folder("META-INF")?.file("container.xml", `<?xml version="1.0" encoding="UTF-8"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`);
        const oebps = zip.folder("OEBPS")!;
        let manifest = "";
        let spine = "";
        let navHtml = `<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>TOC</title></head><body><nav epub:type="toc"><h1>Table of Contents</h1><ol>`;

        for (let i = 0; i < translatedStructure.chapters.length; i++) {
          const chap = translatedStructure.chapters[i];
          const chapFileName = `chap${i}.xhtml`;
          const content = `<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>${chap.title}</title></head><body>${chap.type === 'html' ? chap.content : `<p>${chap.content.replace(/\n/g, '</p><p>')}</p>`}</body></html>`;
          oebps.file(chapFileName, content);
          manifest += `<item id="chap${i}" href="${chapFileName}" media-type="application/xhtml+xml"/>`;
          spine += `<itemref idref="chap${i}"/>`;
          const tocItem = translatedStructure.metadata.toc?.[i];
          navHtml += `<li><a href="${chapFileName}">${tocItem?.title || chap.title}</a></li>`;
        }
        oebps.file("nav.xhtml", navHtml + `</ol></nav></body></html>`);
        oebps.file("content.opf", `<?xml version="1.0" encoding="UTF-8"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="pub-id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="pub-id">id${Date.now()}</dc:identifier><dc:title>${baseName}</dc:title><dc:language>${targetLang}</dc:language></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>${manifest}</manifest><spine>${spine}</spine></package>`);
        blob = await zip.generateAsync({ type: "blob", mimeType });
      } else if (outputFormat === 'pdf') {
        const doc = new jsPDF({ unit: 'pt', format: 'a4' });
        const hasFont = await applyFont(doc);
        if (!hasFont) {
          if (!confirm("한글 폰트 로드에 실패했습니다. 한글이 깨질 수 있습니다. 계속하시겠습니까?")) return;
        }

        const pageWidth = doc.internal.pageSize.getWidth();
        const pageHeight = doc.internal.pageSize.getHeight();

        // 1. 표지 페이지 추가
        if (translatedStructure.metadata.cover) {
          try {
            // 이미지 타입 확인 및 삽입
            const format = translatedStructure.metadata.cover.split(';')[0].split('/')[1]?.toUpperCase() || 'JPEG';
            doc.addImage(translatedStructure.metadata.cover, format, 0, 0, pageWidth, pageHeight, undefined, 'FAST');
            doc.addPage();
          } catch (err) {
            console.warn("PDF Cover image adding failed:", err);
          }
        }


        for (let i = 0; i < translatedStructure.chapters.length; i++) {
          try {
            const chap = translatedStructure.chapters[i];
            const isProbablyCoverChapter = i === 0 && (
              chap.id.toLowerCase().includes('cover') || 
              (chap.content.length < 1500 && (chap.content.toLowerCase().includes('<img') || chap.content.toLowerCase().includes('svg')))
            );
            if (isProbablyCoverChapter && translatedStructure.metadata.cover) continue;

            if (i > 0 || translatedStructure.metadata.cover) doc.addPage();
            
            const cleanTitle = chap.title.replace(/part\d+\.x?html/gi, '').trim() || `Chapter ${i + 1}`;
            doc.outline.add(null, cleanTitle, { pageNumber: doc.getNumberOfPages() });
            
            doc.setFont('NanumGothic', 'normal');
            doc.setFontSize(16);
            doc.text(cleanTitle, 40, 50);
            
            let curY = 80;
            const margin = 40;
            const contentWidth = pageWidth - margin * 2;

            // HTML 파싱 및 순차 렌더링
            const parser = new DOMParser();
            const htmlDoc = parser.parseFromString(chap.content, 'text/html');
            const container = htmlDoc.body || htmlDoc.documentElement;

            const renderNode = async (node: Node) => {
              if (node.nodeType === Node.TEXT_NODE) {
                const text = node.textContent?.replace(/\s+/g, ' ').normalize('NFC').trim();
                if (!text) return;

                doc.setFontSize(10);
                doc.setFont('NanumGothic', 'normal');
                const lines = doc.splitTextToSize(text, contentWidth);
                
                for (const line of lines) {
                  if (curY > pageHeight - 50) {
                    doc.addPage();
                    doc.setFont('NanumGothic', 'normal');
                    curY = 50;
                  }
                  doc.text(line, margin, curY);
                  curY += 14;
                }
              } else if (node.nodeType === Node.ELEMENT_NODE) {
                const el = node as HTMLElement;
                const tagName = el.tagName.toLowerCase();

                if (tagName === 'img') {
                  let src = el.getAttribute('src');
                  // SVG나 xlink:href 대응
                  if (!src) src = el.getAttribute('xlink:href');
                  
                  if (src) {
                    try {
                      // 이미지 타입 및 메타데이터 추출
                      let format = 'JPEG';
                      if (src.startsWith('data:')) {
                        const mime = src.split(':')[1].split(';')[0];
                        format = mime.split('/')[1]?.toUpperCase() || 'JPEG';
                        if (format === 'SVG+XML') format = 'PNG'; // jsPDF-SVG 미지원 시 PNG로 간주 시도 (실제로는 변환 필요)
                      } else {
                        // 외부 URL인 경우 format 추론
                        const ext = src.split('.').pop()?.split(/[?#]/)[0].toUpperCase();
                        format = ext || 'JPEG';
                      }

                      // 임시 이미지를 생성
                      const imgObj = new Image();
                      if (!src.startsWith('data:')) {
                        imgObj.crossOrigin = "anonymous"; // CORS 대응
                      }
                      imgObj.src = src;
                      await new Promise((res, rej) => { 
                        imgObj.onload = res; 
                        imgObj.onerror = () => rej(new Error("Image load failed"));
                        // 타임아웃 추가
                        setTimeout(() => rej(new Error("Image load timeout")), 5000);
                      });

                      let imgW = imgObj.width || 300;
                      let imgH = imgObj.height || 300;
                      
                      const maxW = contentWidth;
                      // 너비에 맞게 축소
                      if (imgW > maxW) {
                        const ratio = maxW / imgW;
                        imgW = maxW;
                        imgH = imgH * ratio;
                      }

                      // 페이지 남은 공간 확인
                      if (curY + imgH > pageHeight - 50) {
                        doc.addPage();
                        curY = 50;
                      }

                      // jsPDF 포맷 호환성을 높이기 위해 Canvas를 이용해 JPEG base64로 변환하여 삽입
                      const canvas = document.createElement('canvas');
                      canvas.width = imgObj.width || 300;
                      canvas.height = imgObj.height || 300;
                      const ctx = canvas.getContext('2d');
                      if (ctx) {
                        // 배경을 흰색으로 칠해 투명 PNG도 문제없도록 설정
                        ctx.fillStyle = '#FFFFFF';
                        ctx.fillRect(0, 0, canvas.width, canvas.height);
                        ctx.drawImage(imgObj, 0, 0, canvas.width, canvas.height);
                        const safeDataUrl = canvas.toDataURL('image/jpeg', 0.95);
                        
                        doc.addImage(safeDataUrl, 'JPEG', (pageWidth - imgW) / 2, curY, imgW, imgH);
                        curY += imgH + 20;
                      }
                    } catch (imgErr) {
                      console.warn("Failed to add image to PDF:", imgErr, src?.substring(0, 100));
                      // 이미지 로드 실패 시 대체 텍스트 표시 시도
                      const alt = el.getAttribute('alt');
                      if (alt) {
                        doc.setFontSize(8);
                        doc.text(`[Image: ${alt}]`, margin, curY);
                        curY += 12;
                      }
                    }
                  }
                } else if (tagName === 'table') {
                  // 간단한 표 렌더링 구현
                  const rows = Array.from(el.querySelectorAll('tr'));
                  if (rows.length > 0) {
                    doc.setFontSize(9);
                    const cellPadding = 5;
                    const rowHeight = 18;
                    
                    // 최대 컬럼 수 계산
                    let maxCols = 0;
                    rows.forEach(row => {
                      maxCols = Math.max(maxCols, row.cells.length);
                    });

                    if (maxCols > 0) {
                      const colWidth = contentWidth / maxCols;
                      
                      // 표 시작 전 여백
                      curY += 10;
                      
                      for (const row of rows) {
                        // 페이지 넘김 확인
                        if (curY + rowHeight > pageHeight - 50) {
                          doc.addPage();
                          curY = 50;
                        }

                        let curX = margin;
                        for (let j = 0; j < row.cells.length; j++) {
                          const cell = row.cells[j];
                          const cellText = cell.textContent?.trim() || "";
                          const isHeader = cell.tagName.toLowerCase() === 'th';
                          
                          // 셀 배경 (헤더용)
                          if (isHeader) {
                            doc.setFillColor(240, 240, 240);
                            doc.rect(curX, curY, colWidth, rowHeight, 'F');
                            doc.setFont('NanumGothic', 'normal');
                          } else {
                            doc.setFont('NanumGothic', 'normal');
                          }
                          
                          // 셀 테두리
                          doc.setDrawColor(200, 200, 200);
                          doc.rect(curX, curY, colWidth, rowHeight, 'S');
                          
                          // 텍스트 출력 (셀 너비에 맞춤)
                          const truncatedText = doc.splitTextToSize(cellText, colWidth - cellPadding * 2);
                          doc.text(truncatedText[0] || "", curX + cellPadding, curY + 12);
                          
                          curX += colWidth;
                        }
                        curY += rowHeight;
                      }
                      curY += 15; // 표 종료 후 여백
                    }
                  }
                } else if (tagName === 'br' || tagName === 'p' || tagName === 'div' || tagName === 'h1' || tagName === 'h2' || tagName === 'h3' || tagName === 'section' || tagName === 'blockquote') {
                  // 줄바꿈이나 문단 구분 시 여백 추가
                  const isHeader = tagName.startsWith('h');
                  const isBlock = tagName === 'p' || tagName === 'div' || tagName === 'section' || tagName === 'blockquote';
                  
                  if (isHeader) {
                    curY += 10;
                    doc.setFontSize(tagName === 'h1' ? 14 : tagName === 'h2' ? 12 : 11);
                    doc.setFont('NanumGothic', 'normal');
                  } else if (isBlock) {
                    curY += 5;
                  }
                  
                  for (const child of Array.from(node.childNodes)) {
                    await renderNode(child);
                  }
                  
                  if (isHeader || isBlock) {
                    curY += 10;
                    doc.setFont('NanumGothic', 'normal');
                    doc.setFontSize(10);
                  }
                } else {
                  // 기타 태그(span, em, strong 등)는 자식 노드 순회
                  const oldFont = doc.getFont().fontStyle;
                  if (tagName === 'strong' || tagName === 'b') {
                    doc.setFont('NanumGothic', 'normal');
                  }
                  
                  for (const child of Array.from(node.childNodes)) {
                    await renderNode(child);
                  }
                  
                  if (tagName === 'strong' || tagName === 'b') {
                    doc.setFont('NanumGothic', oldFont);
                  }
                }
              }
            };

            await renderNode(container);

          } catch (chapterErr) {
            console.error(`Error rendering chapter ${i}:`, chapterErr);
          }
        }
        console.log("Saving PDF with name:", downloadName);
        doc.save(downloadName);
        return;
      } else {
        mimeType = "text/plain;charset=utf-8";
        const fullText = translatedStructure.chapters.map(c => `[${c.title}]\n\n${c.content.replace(/<[^>]*>?/gm, '')}`).join('\n\n---\n\n');
        const BOM = new Uint8Array([0xEF, 0xBB, 0xBF]);
        blob = new Blob([BOM, fullText], { type: mimeType });
      }

      // 2. 다운로드 트리거 - MIME 타입을 정확하게 지정하여 브라우저가 파일명을 UUID로 변환하지 않도록 함
      let finalMimeType = 'application/octet-stream';
      if (outputFormat === 'epub') finalMimeType = 'application/epub+zip';
      else if (outputFormat === 'txt') finalMimeType = 'text/plain;charset=utf-8';

      // Blob의 MIME 타입을 정확하게 재지정
      const typedBlob = new Blob([blob], { type: finalMimeType });
      const url = window.URL.createObjectURL(typedBlob);
      
      const link = document.createElement('a');
      link.href = url;
      link.download = downloadName;   // setAttribute 대신 property 직접 대입
      
      link.style.display = 'none';
      link.style.position = 'absolute';
      link.style.top = '-9999px';
      document.body.appendChild(link);
      
      console.log(`Triggering download: ${downloadName}, MIME: ${finalMimeType}`);
      link.click();
      
      setTimeout(() => {
        if (document.body.contains(link)) document.body.removeChild(link);
        window.URL.revokeObjectURL(url);
        console.log(`Resources revoked for: ${downloadName}`);
      }, 3000); 

    } catch (error: any) {
      console.error("Critical Download Error:", error);
      alert(`파일 생성 또는 다운로드 중 오류가 발생했습니다: ${error.message || error}`);
    }
  };

  // 뷰어에서 HTML 렌더링을 안전하게 하기 위한 클리닝 함수
  const cleanHtml = (html: string) => {
    if (!html) return "";
    return html
      .replace(/<\?xml[^>]*\?>/gi, '')
      .replace(/<!DOCTYPE[^>]*>/gi, '')
      .replace(/<html[^>]*>/gi, '<div class="epub-content">')
      .replace(/<\/html>/gi, '</div>')
      .replace(/<body[^>]*>/gi, '<div>')
      .replace(/<\/body>/gi, '</div>')
      .replace(/<head[^>]*>[\s\S]*?<\/head>/gi, '')
      .replace(/<link[^>]*>/gi, '')
      // src가 완전히 비거나 '#', null, undefined 인 이미지만 제거 (data: URL이 있는 이미지는 유지)
      .replace(/<img([^>]*)src=["'](?:#|null|undefined)["']([^>]*)>/gi, '')
      .replace(/<img(?![^>]*src=)[^>]*>/gi, '')  // src 속성 자체가 없는 img 태그 제거
      .trim();
  };

  return (
    <div className="min-h-screen">
      {/* Navigation */}
      <nav className="glass sticky top-0 z-50 px-6 py-4 flex items-center justify-between mx-4 mt-4">
        <div className="flex items-center gap-2">
          <Languages className="text-secondary w-8 h-8" />
          <span className="text-2xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-primary to-secondary">
            TranslateFlow
          </span>
        </div>

        <div className="flex items-center gap-4">
          {user ? (
            <div className="flex items-center gap-3">
              <span className="text-sm font-medium hidden sm:inline">{user.displayName}님</span>
              <button 
                onClick={() => logout()}
                className="w-10 h-10 rounded-full glass border p-1"
              >
                <img src={user.photoURL || ""} alt="profile" className="rounded-full" />
              </button>
            </div>
          ) : (
            <button 
              onClick={() => signInWithGoogle()}
              className="btn-premium flex items-center gap-2"
            >
              <LogIn size={20} />
              <span>로그인</span>
            </button>
          )}
        </div>
      </nav>

      {/* Main Content */}
      <main className={`py-20 transition-all duration-500 ${status === 'viewing' ? 'px-4 md:px-10 max-w-none w-full' : 'container'}`}>
        <AnimatePresence mode="wait">
          {status === 'idle' && (
            <motion.div
              key="idle"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -20 }}
              className="text-center"
            >
              <h1 className="text-5xl md:text-7xl font-bold mb-6 tracking-tight">
                당신의 문서를 <br />
                <span className="bg-clip-text text-transparent bg-gradient-to-r from-primary to-secondary">
                  새로운 언어로
                </span>
                &nbsp;읽는 경험
              </h1>
              <p className="text-xl text-text-secondary mb-12 max-w-2xl mx-auto leading-relaxed">
                EPUB, PDF 파일을 업로드하고 Google 번역을 통해 편리하게 읽으세요. 
                API 없이 순차 번역 기법을 사용합니다.
              </p>

              <label className="btn-premium px-10 py-5 text-xl cursor-pointer inline-flex w-auto mx-auto group">
                <Upload size={28} className="group-hover:scale-110 transition-transform" />
                <span className="ml-3">파일 업로드 (EPUB / PDF)</span>
                <input type="file" className="hidden" accept=".epub,.pdf" onChange={handleFileUpload} />
              </label>
            </motion.div>
          )}

          {status === 'ready' && (
            <motion.div
              key="ready"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -20 }}
              className="max-w-4xl mx-auto"
            >
              <div className="glass-card p-10 rounded-3xl mb-8">
                <div className="flex flex-col md:flex-row justify-between items-center gap-6 mb-8">
                  <div className="flex items-center gap-4">
                    {docStructure?.metadata.cover ? (
                      <img src={docStructure.metadata.cover} alt="cover" className="w-16 h-20 object-cover rounded-lg shadow-lg" />
                    ) : (
                      <div className="w-16 h-20 rounded-lg bg-primary/20 flex items-center justify-center">
                        <FileText className="text-primary w-8 h-8" />
                      </div>
                    )}
                    <div>
                      <h2 className="text-2xl font-bold line-clamp-1">{docStructure?.metadata.title || file?.name}</h2>
                      <p className="text-text-secondary">문서 분석 완료. 총 {docStructure?.chapters.length || 0}개의 섹션이 추출되었습니다.</p>
                    </div>
                  </div>
                  
                  <div className="flex items-center gap-4 bg-white/5 p-2 rounded-2xl border border-white/10">
                    <Languages className="text-secondary ml-2" size={20} />
                    <select 
                      value={targetLang}
                      onChange={(e) => setTargetLang(e.target.value)}
                      className="bg-transparent text-white focus:outline-none px-2 py-1 cursor-pointer"
                    >
                      <option value="ko" className="bg-bg-dark">한국어</option>
                      <option value="en" className="bg-bg-dark">English</option>
                      <option value="ja" className="bg-bg-dark">日本語</option>
                      <option value="zh" className="bg-bg-dark">中文</option>
                      <option value="es" className="bg-bg-dark">Español</option>
                    </select>
                  </div>
                </div>

                <div className="h-64 overflow-y-auto mb-8 bg-black/20 rounded-2xl p-6 text-left border border-white/5">
                  <p className="text-xs font-bold text-primary mb-2 uppercase tracking-widest">미리보기</p>
                  <div className="space-y-4 text-text-secondary leading-relaxed">
                    {docStructure?.chapters.slice(0, 3).map((chap, i) => (
                      <div key={i}>
                        <p className="text-xs font-bold text-secondary">{chap.title}</p>
                        <p className="line-clamp-6 whitespace-pre-wrap">{chap.content.replace(/<[^>]*>?/gm, ' ').replace(/\s+/g, ' ').trim().substring(0, 500)}...</p>
                      </div>
                    ))}
                    {(docStructure?.chapters.length || 0) > 3 && <p className="text-center opacity-50 italic">... 외 {docStructure!.chapters.length - 3}개 섹션</p>}
                  </div>
                </div>

                <div className="flex gap-4">
                  <button onClick={() => setStatus('idle')} className="glass-card px-8 py-4 rounded-xl hover:bg-white/10 transition-colors">
                    취소
                  </button>
                  <button onClick={startTranslation} className="btn-premium flex-1 py-4 text-lg justify-center">
                    <Languages size={24} />
                    번역 시작하기
                  </button>
                </div>
              </div>
            </motion.div>
          )}

          {(status === 'parsing' || status === 'translating') && (
            <motion.div
              key="progress"
              initial={{ opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.9 }}
              className="max-w-xl mx-auto glass-card p-12 rounded-3xl text-center"
            >
              <div className="relative w-24 h-24 mx-auto mb-8">
                <div className="absolute inset-0 bg-primary/20 rounded-full animate-ping" />
                <div className="relative bg-bg-dark rounded-full w-full h-full flex items-center justify-center border border-primary/30">
                  <Loader2 className="w-10 h-10 text-primary animate-spin" />
                </div>
              </div>

              <h2 className="text-3xl font-bold mb-4">
                {status === 'parsing' ? '파일을 분석하는 중...' : '문서를 번역하는 중...'}
              </h2>
              
              <div className="w-full bg-white/10 h-3 rounded-full overflow-hidden mb-6">
                <motion.div 
                  className="h-full bg-gradient-to-r from-primary to-secondary"
                  initial={{ width: 0 }}
                  animate={{ width: `${progress}%` }}
                  transition={{ duration: 0.5 }}
                />
              </div>

              <div className="flex flex-col gap-2">
                <p className="text-xl font-medium text-text-primary">
                  {status === 'translating' ? `${Math.round(progress)}% 완료` : '구조를 분석하고 있습니다...'}
                </p>
                <p className="text-sm text-text-secondary">
                  {status === 'translating' 
                    ? '원본의 레이아웃(그림, 표, 링크)을 보존하며 번역을 진행합니다.' 
                    : '파일의 장 구분과 이미지 위치 정보를 추출하고 있습니다.'}
                </p>
              </div>
            </motion.div>
          )}

          {status === 'viewing' && (
            <motion.div
              key="viewer"
              initial={{ opacity: 0, scale: 0.98 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0 }}
              className="w-full grid gap-6"
            >
              <div className="flex justify-between items-center glass p-6 rounded-2xl relative z-[200]">
                <div className="flex items-center gap-4">
                  {translatedStructure?.metadata.cover ? (
                    <img src={translatedStructure.metadata.cover} alt="cover" className="w-10 h-12 object-cover rounded shadow" />
                  ) : (
                    <FileText className="text-primary w-8 h-8" />
                  )}
                  <div>
                    <h3 className="text-xl font-bold truncate max-w-md">{translatedFileName || file?.name}</h3>
                    <p className="text-text-secondary text-sm">레이아웃 보존 번역 완료</p>
                  </div>
                </div>
                <div className="flex gap-4 items-center">
                  <div className="flex items-center gap-2 bg-white/5 p-2 rounded-xl border border-white/10">
                    <span className="text-xs font-bold text-text-secondary ml-2 uppercase">포맷</span>
                    <select 
                      value={outputFormat}
                      onChange={(e) => setOutputFormat(e.target.value as any)}
                      className="bg-transparent text-white text-sm focus:outline-none px-2 py-1 cursor-pointer"
                    >
                      <option value="pdf" className="bg-bg-dark">PDF</option>
                      <option value="epub" className="bg-bg-dark">EPUB</option>
                      <option value="txt" className="bg-bg-dark">TXT</option>
                    </select>
                  </div>
                  <div className="flex items-center gap-1 bg-white/5 p-1 rounded-xl border border-white/10">
                    <button 
                      onClick={() => setDisplayMode('translated')}
                      className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-colors ${displayMode === 'translated' ? 'bg-secondary text-white' : 'text-text-secondary hover:text-white'}`}
                    >
                      번역문
                    </button>
                    <button 
                      onClick={() => setDisplayMode('original')}
                      className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-colors ${displayMode === 'original' ? 'bg-secondary text-white' : 'text-text-secondary hover:text-white'}`}
                    >
                      원문
                    </button>
                    <button 
                      onClick={() => setDisplayMode('dual')}
                      className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-colors ${displayMode === 'dual' ? 'bg-secondary text-white' : 'text-text-secondary hover:text-white'}`}
                    >
                      교차 보기
                    </button>
                  </div>
                  <div className="flex items-center gap-1 bg-white/5 p-1 rounded-xl border border-white/10">
                    <button 
                      onClick={() => setViewMode('layout')}
                      className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-colors ${viewMode === 'layout' ? 'bg-primary text-white' : 'text-text-secondary hover:text-white'}`}
                    >
                      레이아웃
                    </button>
                    <button 
                      onClick={() => setViewMode('text')}
                      className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-colors ${viewMode === 'text' ? 'bg-primary text-white' : 'text-text-secondary hover:text-white'}`}
                    >
                      텍스트
                    </button>
                  </div>
                  {/* TTS 컨트롤 패널 */}
                  <div className="relative">
                    <button
                      onClick={() => setShowTtsPanel(p => !p)}
                      className={`glass-card p-3 rounded-xl transition-colors flex items-center gap-1.5 ${isSpeaking ? 'bg-secondary/30 border-secondary/50' : 'hover:bg-secondary/20'}`}
                      title="TTS 설정"
                    >
                      {isSpeaking ? <Pause size={18} /> : <Volume2 size={18} />}
                      <Settings size={14} className="opacity-60" />
                      {showTtsPanel ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                    </button>

                    {/* 드롭다운 TTS 패널 */}
                    <AnimatePresence>
                      {showTtsPanel && (
                        <motion.div
                          initial={{ opacity: 0, y: -8, scale: 0.97 }}
                          animate={{ opacity: 1, y: 0, scale: 1 }}
                          exit={{ opacity: 0, y: -8, scale: 0.97 }}
                          transition={{ duration: 0.15 }}
                          className="absolute right-0 top-14 z-[9999] w-80 glass-card rounded-2xl p-5 border border-white/15 shadow-2xl"
                          style={{ background: 'rgba(15,23,42,0.97)', backdropFilter: 'blur(20px)' }}
                        >
                          <p className="text-xs font-black text-secondary uppercase tracking-widest mb-4 flex items-center gap-2">
                            <Volume2 size={14} /> TTS 설정
                          </p>

                          {/* 엔진 선택 */}
                          <div className="mb-4">
                            <p className="text-xs text-text-secondary mb-2 font-bold">엔진</p>
                            <div className="flex gap-2">
                              <button
                                onClick={() => setTtsEngine('browser')}
                                className={`flex-1 py-1.5 rounded-lg text-xs font-bold transition-colors ${ttsEngine === 'browser' ? 'bg-primary text-white' : 'bg-white/5 text-text-secondary hover:text-white'}`}
                              >
                                🌐 브라우저 (무료)
                              </button>
                              <button
                                onClick={() => setTtsEngine('gemini')}
                                className={`flex-1 py-1.5 rounded-lg text-xs font-bold transition-colors ${ttsEngine === 'gemini' ? 'bg-secondary text-white' : 'bg-white/5 text-text-secondary hover:text-white'}`}
                              >
                                ✨ Gemini TTS
                              </button>
                            </div>
                          </div>

                          {ttsEngine === 'browser' ? (
                            <>
                              {/* 음성 선택 */}
                              <div className="mb-3">
                                <p className="text-xs text-text-secondary mb-1.5 font-bold">음성</p>
                                <select
                                  value={ttsVoiceURI}
                                  onChange={e => setTtsVoiceURI(e.target.value)}
                                  className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-1.5 text-xs text-white focus:outline-none focus:border-primary/50"
                                >
                                  {ttsVoices.length === 0 && <option value="">음성 로딩 중...</option>}
                                  {ttsVoices.map(v => (
                                    <option key={v.voiceURI} value={v.voiceURI} className="bg-bg-dark">
                                      {v.name.includes('Natural') || !v.localService ? '⭐ ' : ''}{v.name} ({v.lang})
                                    </option>
                                  ))}
                                </select>
                              </div>
                            </>
                          ) : (
                            <div className="mb-3">
                              <p className="text-xs text-text-secondary mb-1.5 font-bold">Gemini API 키</p>
                              <input
                                type="password"
                                value={geminiApiKey}
                                onChange={e => setGeminiApiKey(e.target.value)}
                                placeholder="AIza..."
                                className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-1.5 text-xs text-white placeholder-white/30 focus:outline-none focus:border-secondary/50"
                              />
                              <p className="text-xs text-text-secondary mt-1 opacity-60">
                                Google AI Studio에서 발급 · 2.5 Flash TTS 무료
                              </p>
                            </div>
                          )}

                          {/* 속도 슬라이더 */}
                          <div className="mb-3">
                            <div className="flex justify-between mb-1">
                              <p className="text-xs text-text-secondary font-bold">속도</p>
                              <span className="text-xs text-primary font-mono">{ttsRate.toFixed(1)}x</span>
                            </div>
                            <input
                              type="range" min="0.5" max="2.0" step="0.1"
                              value={ttsRate}
                              onChange={e => setTtsRate(Number(e.target.value))}
                              className="w-full accent-primary"
                            />
                            <div className="flex justify-between text-xs text-white/30 mt-0.5">
                              <span>0.5x</span><span>1.0x</span><span>2.0x</span>
                            </div>
                          </div>

                          {ttsEngine === 'browser' && (
                            <>
                              {/* 음높이 슬라이더 */}
                              <div className="mb-3">
                                <div className="flex justify-between mb-1">
                                  <p className="text-xs text-text-secondary font-bold">음높이 (Pitch)</p>
                                  <span className="text-xs text-secondary font-mono">{ttsPitch.toFixed(1)}</span>
                                </div>
                                <input
                                  type="range" min="0.5" max="2.0" step="0.1"
                                  value={ttsPitch}
                                  onChange={e => setTtsPitch(Number(e.target.value))}
                                  className="w-full accent-secondary"
                                />
                                <div className="flex justify-between text-xs text-white/30 mt-0.5">
                                  <span>낮음</span><span>기본</span><span>높음</span>
                                </div>
                              </div>

                              {/* 볼륨 슬라이더 */}
                              <div className="mb-4">
                                <div className="flex justify-between mb-1">
                                  <p className="text-xs text-text-secondary font-bold">볼륨</p>
                                  <span className="text-xs text-white/60 font-mono">{Math.round(ttsVolume * 100)}%</span>
                                </div>
                                <input
                                  type="range" min="0" max="1" step="0.05"
                                  value={ttsVolume}
                                  onChange={e => setTtsVolume(Number(e.target.value))}
                                  className="w-full accent-white"
                                />
                              </div>
                            </>
                          )}

                          {/* 재생 버튼 */}
                          <button
                            onClick={() => {
                              const text = (displayMode === 'original' ? docStructure : translatedStructure)
                                ?.chapters.map(c => c.content.replace(/<[^>]*>?/gm, '')).join(' ') || '';
                              handleTTS(text);
                            }}
                            className={`w-full py-2.5 rounded-xl text-sm font-bold transition-all flex items-center justify-center gap-2 ${
                              isSpeaking
                                ? 'bg-red-500/20 border border-red-500/30 text-red-400 hover:bg-red-500/30'
                                : 'btn-premium'
                            }`}
                          >
                            {isSpeaking ? <><Pause size={16}/> 정지</> : <><Volume2 size={16}/> 읽기 시작</>}
                          </button>
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </div>

                  <button onClick={downloadFile} className="btn-premium">
                    <Download size={20} />
                    번역본 다운로드
                  </button>
                  <button onClick={() => setStatus('idle')} className="glass-card p-3 rounded-xl hover:bg-red-500/20 transition-colors">
                    <X />
                  </button>
                </div>
              </div>

              <div className="grid grid-cols-1 gap-6 h-[calc(100vh-240px)] min-h-[600px] transition-all duration-500">
                {displayMode === 'original' && (
                  <motion.div 
                    initial={{ opacity: 0, x: -20 }}
                    animate={{ opacity: 1, x: 0 }}
                    className="glass-card p-8 rounded-3xl overflow-y-auto text-left"
                  >
                    <h4 className="text-secondary font-bold mb-4 flex items-center gap-2 sticky top-0 bg-bg-dark/80 backdrop-blur pb-2 z-10">
                      <FileText size={18} /> 원문
                    </h4>
                    
                    {/* 레이아웃 모드에서 표지 표시 (첫 챕터가 이미 표지 성격이 아닐 때만) */}
                    {viewMode === 'layout' && docStructure?.metadata.cover && 
                     !(docStructure?.chapters[0]?.id.toLowerCase().includes('cover') || 
                       docStructure?.chapters[0]?.content.toLowerCase().includes('<img')) && (
                      <div className="mb-8 flex justify-center bg-black/20 p-8 rounded-2xl">
                        <img src={docStructure.metadata.cover} alt="cover" className="max-h-[500px] shadow-2xl rounded-lg" />
                      </div>
                    )}

                    <div className="space-y-8 text-text-secondary leading-relaxed">
                      {docStructure?.chapters.map((chap, i) => {
                        const isProbablyCoverChapter = i === 0 && (
                          chap.id.toLowerCase().includes('cover') || 
                          (chap.content.length < 1500 && (chap.content.toLowerCase().includes('<img') || chap.content.toLowerCase().includes('svg')))
                        );
                        
                        // 레이아웃 모드에서 표지 챕터는 이미 상단에서 수동으로 보여주었으므로 본문에서는 숨김
                        if (viewMode === 'layout' && isProbablyCoverChapter && docStructure.metadata.cover) return null;

                        return (
                          <div key={i} className="border-b border-white/5 pb-4 last:border-0">
                            <p className="text-xs font-bold text-primary mb-2">{chap.title}</p>
                            {viewMode === 'layout' ? (
                              <div dangerouslySetInnerHTML={{ __html: cleanHtml(chap.content) }} className="prose prose-invert max-w-none text-sm overflow-x-auto" />
                            ) : (
                              <div 
                                dangerouslySetInnerHTML={{ 
                                  __html: chap.content
                                    .replace(/<(h1|h2|h3|header|title)[^>]*>([\s\S]*?)<\/\1>/gi, '<h3 class="header-text">$2</h3>')
                                    .replace(/<(p|div|section|li)[^>]*>/gi, '<br/><br/>')
                                    .replace(/<br\s*\/?>/gi, '<br/>')
                                    .replace(/<[^>]*>?/gm, (match) => match.startsWith('<h3') || match.startsWith('</h3') || match.startsWith('<br') ? match : '')
                                    .replace(/(<br\/>\s*){3,}/g, '<br/><br/>')
                                    .trim() 
                                }} 
                                className="text-sm text-text-secondary leading-relaxed structure-preserved-text" 
                              />
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </motion.div>
                )}
                
                {displayMode === 'translated' && (
                  <motion.div 
                    initial={{ opacity: 0, x: 20 }}
                    animate={{ opacity: 1, x: 0 }}
                    className="glass-card p-8 rounded-3xl overflow-y-auto text-left border-primary/20"
                  >
                    <h4 className="text-primary font-bold mb-4 flex items-center gap-2 sticky top-0 bg-bg-dark/80 backdrop-blur pb-2 z-10">
                      <Languages size={18} /> 번역본
                    </h4>
                    
                    {/* 레이아웃 모드에서 표지 표시 */}
                    {viewMode === 'layout' && translatedStructure?.metadata.cover && 
                     !(translatedStructure?.chapters[0]?.id.toLowerCase().includes('cover') || 
                       translatedStructure?.chapters[0]?.content.toLowerCase().includes('<img')) && (
                      <div className="mb-8 flex justify-center bg-black/20 p-8 rounded-2xl border border-primary/10">
                        <img src={translatedStructure.metadata.cover} alt="cover" className="max-h-[500px] shadow-2xl rounded-lg" />
                      </div>
                    )}

                    <div className="space-y-8 leading-relaxed">
                      {translatedStructure?.chapters.map((chap, i) => {
                        const isProbablyCoverChapter = i === 0 && (
                          chap.id.toLowerCase().includes('cover') || 
                          (chap.content.length < 1500 && (chap.content.toLowerCase().includes('<img') || chap.content.toLowerCase().includes('svg')))
                        );

                        if (viewMode === 'layout' && isProbablyCoverChapter && translatedStructure.metadata.cover) return null;

                        return (
                          <div key={i} className="border-b border-white/5 pb-4 last:border-0">
                            <p className="text-xs font-bold text-primary mb-2">{chap.title}</p>
                            {viewMode === 'layout' ? (
                              <div dangerouslySetInnerHTML={{ __html: cleanHtml(chap.content) }} className="prose prose-invert max-w-none text-sm overflow-x-auto" />
                            ) : (
                              <div 
                                dangerouslySetInnerHTML={{ 
                                  __html: chap.content
                                    .replace(/<(h1|h2|h3|header|title)[^>]*>([\s\S]*?)<\/\1>/gi, '<h3 class="header-text">$2</h3>')
                                    .replace(/<(p|div|section|li)[^>]*>/gi, '<br/><br/>')
                                    .replace(/<br\s*\/?>/gi, '<br/>')
                                    .replace(/<[^>]*>?/gm, (match) => match.startsWith('<h3') || match.startsWith('</h3') || match.startsWith('<br') ? match : '')
                                    .replace(/(<br\/>\s*){3,}/g, '<br/><br/>')
                                    .trim() 
                                }} 
                                className="text-sm text-text-primary leading-relaxed structure-preserved-text" 
                              />
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </motion.div>
                )}

                {displayMode === 'dual' && (
                  <motion.div 
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    className="glass-card p-8 rounded-3xl overflow-y-auto text-left border-secondary/20 h-full"
                  >
                    <h4 className="text-secondary font-bold mb-6 flex items-center gap-2 sticky top-0 bg-bg-dark/80 backdrop-blur pb-4 z-10 border-b border-white/5">
                      <Languages size={18} /> 행간 교차 보기 (원문 + 번역문)
                    </h4>
                    <div className="space-y-12">
                      {translatedStructure?.chapters.map((chap, i) => {
                        const originalChap = docStructure?.chapters[i];
                        
                        // 텍스트 모드에서의 교차 처리
                        const getBlocks = (content: string) => {
                          return content
                            .replace(/<(h1|h2|h3|header|title)[^>]*>([\s\S]*?)<\/\1>/gi, '<h3 class="header-text">$2</h3>@@BLOCK@@')
                            .replace(/<(p|div|section|li)[^>]*>/gi, '@@BLOCK@@')
                            .replace(/<br\s*\/?>/gi, '@@BLOCK@@')
                            .replace(/<[^>]*>?/gm, (match) => match.startsWith('<h3') || match.startsWith('</h3') ? match : '')
                            .split('@@BLOCK@@')
                            .map(b => b.trim())
                            .filter(b => b.length > 0);
                        };

                        const origBlocks = originalChap ? getBlocks(originalChap.content) : [];
                        const transBlocks = getBlocks(chap.content);
                        const maxLen = Math.max(origBlocks.length, transBlocks.length);
                        const interleaved = [];
                        for (let j = 0; j < maxLen; j++) {
                          if (origBlocks[j]) interleaved.push({ type: 'orig', content: origBlocks[j] });
                          if (transBlocks[j]) interleaved.push({ type: 'trans', content: transBlocks[j] });
                        }

                        return (
                          <div key={i} className="pb-8 border-b border-white/5">
                            <p className="text-xs font-black text-secondary mb-6 tracking-widest uppercase opacity-50 px-2 py-1 bg-white/5 inline-block rounded">{chap.title}</p>
                            <div className="space-y-4">
                              {viewMode === 'layout' ? (
                                <div className="grid grid-cols-2 gap-4">
                                  <div dangerouslySetInnerHTML={{ __html: cleanHtml(originalChap?.content || "") }} className="prose prose-invert max-w-none text-xs opacity-50 border-r border-white/5 pr-4" />
                                  <div dangerouslySetInnerHTML={{ __html: cleanHtml(chap.content) }} className="prose prose-invert max-w-none text-sm" />
                                </div>
                              ) : (
                                interleaved.map((block, idx) => (
                                  <div 
                                    key={idx} 
                                    className={`${block.type === 'orig' ? 'text-text-secondary italic text-xs opacity-60 pl-4 border-l-2 border-white/10 mb-1' : 'text-text-primary text-sm font-medium mb-4'} leading-relaxed structure-preserved-text`}
                                    dangerouslySetInnerHTML={{ __html: block.content }}
                                  />
                                ))
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </motion.div>
                )}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </main>
    </div>
  );
};

export default App;
