# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

NativeMind는 로컬 AI 모델을 사용하는 프라이빗 브라우저 확장프로그램입니다. Ollama와 WebLLM을 통해 완전히 오프라인에서 작동하며, 웹 페이지 요약, 번역, 작성 도구, 채팅 등의 기능을 제공합니다.

## Core Architecture

- **Browser Extension Framework**: WXT (Web Extension Tools) 기반
- **Frontend**: Vue 3 + TypeScript + Composition API
- **Styling**: TailwindCSS 4.x
- **State Management**: Pinia (Vue store)
- **AI Integration**: 
  - Ollama (로컬 LLM 서버)
  - WebLLM (브라우저 내 WebAssembly 실행)
  - AI SDK (@ai-sdk/openai, @ai-sdk/provider)
- **Build**: Vite + TypeScript

## Key Directory Structure

- `entrypoints/`: WXT 진입점들
  - `background/`: 백그라운드 서비스 워커
  - `content/`: 콘텐츠 스크립트 (메인 UI)
  - `popup/`: 확장프로그램 팝업
  - `main-world-injected/`: 메인 월드 스크립트
- `components/`: 재사용 가능한 Vue 컴포넌트
- `composables/`: Vue 컴포저블 함수들
- `utils/`: 유틸리티 함수들
  - `llm/`: AI 모델 관련 로직
  - `translator/`: 번역 기능
  - `rpc/`: 크로스 컨텍스트 RPC 통신
- `locales/`: 다국어 지원 파일들
- `assets/`: 정적 자산 (아이콘, 폰트)

## Development Commands

```bash
# 개발 서버 시작
pnpm dev              # Chrome 개발 (기본)
pnpm dev:firefox      # Firefox 개발
pnpm dev:edge         # Edge 개발

# 빌드
pnpm build:prod       # 프로덕션 빌드
pnpm build:beta       # 베타 빌드
pnpm zip:prod         # 프로덕션 zip 생성
pnpm zip:beta         # 베타 zip 생성

# 코드 품질
pnpm lint             # ESLint 실행
pnpm lint:fix         # ESLint 자동 수정
pnpm check            # TypeScript + ESLint 체크
pnpm compile          # TypeScript 컴파일 체크

# 테스트
pnpm test:unit        # 유닛 테스트 (Vitest)
pnpm test:e2e         # E2E 테스트 (Playwright)
```

## Technical Notes

### Cross-Context Communication
- **RPC System**: `utils/rpc/` 디렉토리의 birpc 기반 통신
- Background ↔ Content ↔ Popup 간 타입 안전한 메시지 패싱
- `utils/rpc/background-fns.ts`, `content-fns.ts` 등에서 함수 정의

### AI Model Integration
- **Ollama**: `utils/llm/ollama.ts`에서 로컬 서버 통신
- **WebLLM**: `utils/llm/web-llm.ts`에서 브라우저 내 실행
- **Model Management**: `utils/llm/models.ts`에서 지원 모델 정의
- **Provider System**: `utils/llm/providers/` 디렉토리의 통합 인터페이스

### State Management
- **Global Store**: `entrypoints/content/store.ts`의 Pinia 스토어
- **Tab-specific State**: `utils/tab-store/` 디렉토리
- **User Config**: `utils/user-config/` 디렉토리의 설정 관리

### Internationalization
- **Vue i18n**: 다국어 지원 (13개 언어)
- **Locale Files**: `locales/` 디렉토리의 JSON 파일들
- **Browser Integration**: `utils/i18n/` 디렉토리의 브라우저 로케일 감지

### Browser-Specific Builds
- **Firefox**: `wxt.config.ts`에서 Firefox 전용 설정
- **Manifest Differences**: 브라우저별 권한 및 기능 차이 처리
- **External Dependencies**: Firefox에서 WebLLM 제외 빌드

## Code Style Guidelines

- **ESLint**: Stylistic 플러그인 사용, 세미콜론 없음, 단일 따옴표
- **Import Sorting**: simple-import-sort 플러그인 사용
- **Console Logs**: 프로덕션에서 금지 (`no-console` 규칙)
- **Vue Conventions**: 
  - Composition API 사용
  - `<script setup>` 스타일
  - PascalCase 컴포넌트 속성

## Testing Strategy

- **Unit Tests**: Vitest + Vue Test Utils
- **E2E Tests**: Playwright (크롬 확장프로그램 테스트)
- **Test Files**: `tests/` 디렉토리와 각 컴포넌트 옆 `.test.ts` 파일

## Security Considerations

- **CSP**: Content Security Policy 설정으로 WASM 실행 허용
- **Permissions**: 최소한의 브라우저 권한 요청
- **Local Processing**: 모든 AI 처리는 로컬에서 수행
- **No External APIs**: 외부 AI 서비스 의존성 없음