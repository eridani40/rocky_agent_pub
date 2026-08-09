/**
 * file-format.ts 单测 —— 分类常量闭合性 + getFileFormat 边界覆盖
 *
 * 参考:
 *   states/v0.0.241/verify/test-plan.md（UT 范围）
 *   specs/tech/version_logs/v0.0.241/change_plan.md 模块 A
 *   task.json T1 acceptanceCriteria #1（11 格式 + md + .env.* + 大小写 + unsupported）
 */
import { describe, it, expect } from 'vitest';
import {
  getFileFormat,
  getCategory,
  isBuiltinEditable,
  isImagePath,
  isRemoteLinkPath,
  looksBinary,
  type FileFormat,
  type FileFormatCategory,
} from '../../file-format';

describe('getFileFormat — 11 格式 + md 命中', () => {
  const cases: Array<[string, FileFormat]> = [
    ['a.json', 'json'],
    ['a.jsonl', 'jsonl'],
    ['a.yaml', 'yaml'],
    ['a.yml', 'yaml'],
    ['a.xml', 'xml'],
    ['a.toml', 'toml'],
    ['a.csv', 'csv'],
    ['a.tsv', 'tsv'],
    ['a.txt', 'txt'],
    ['a.ini', 'ini'],
    ['a.log', 'log'],
    ['a.md', 'md'],
    ['.env', 'env'],
  ];
  for (const [path, expected] of cases) {
    it(`getFileFormat('${path}') === '${expected}'`, () => {
      expect(getFileFormat(path)).toBe(expected);
    });
  }
});

describe('getFileFormat — .env.* 系列当 env 处理', () => {
  const envCases = ['.env', '.env.local', '.env.production', '.env.development'];
  for (const p of envCases) {
    it(`getFileFormat('${p}') === 'env'`, () => {
      expect(getFileFormat(p)).toBe('env');
    });
  }
});

describe('getFileFormat — 大小写归一化', () => {
  it('.JSON / .Json / .YAML 命中（大小写不敏感）', () => {
    expect(getFileFormat('a.JSON')).toBe('json');
    expect(getFileFormat('a.Json')).toBe('json');
    expect(getFileFormat('a.YAML')).toBe('yaml');
    expect(getFileFormat('a.Xml')).toBe('xml');
    expect(getFileFormat('README.MD')).toBe('md');
  });
});

describe('getFileFormat — 多扩展名取最后一段', () => {
  it('.user.config.json → json（取最后一个 .）', () => {
    expect(getFileFormat('config/.user.config.json')).toBe('json');
  });
  it('spec.yaml.bak → null（.bak 不在表）', () => {
    expect(getFileFormat('a/spec.yaml.bak')).toBeNull();
  });
});

describe('getFileFormat — unsupported（编程语言/二进制 → null）', () => {
  const unsupported = [
    'a.py',
    'main.js',
    'Main.java',
    'a.cpp',
    'a.go',
    'a.ts',
    'a.png',
    'a.jpg',
    'a.pdf',
    'a.exe',
    'Makefile', // 无扩展名
    '', // 空字符串
  ];
  for (const p of unsupported) {
    it(`getFileFormat('${p}') === null`, () => {
      expect(getFileFormat(p)).toBeNull();
    });
  }
});

describe('getFileFormat — 带路径前缀（basename 取最后一段）', () => {
  it('workspace 子目录里的文件命中', () => {
    expect(getFileFormat('dir/sub/data.json')).toBe('json');
    expect(getFileFormat('/abs/path/to/config.yaml')).toBe('yaml');
  });
  it('Windows 风格反斜杠路径', () => {
    expect(getFileFormat('dir\\sub\\data.csv')).toBe('csv');
  });
});

describe('getCategory — 12 FileFormat case 闭合', () => {
  const table: Array<[FileFormat, FileFormatCategory]> = [
    ['md', 'md'],
    ['json', 'structured'],
    ['jsonl', 'structured'],
    ['yaml', 'structured'],
    ['xml', 'structured'],
    ['toml', 'structured'],
    ['csv', 'structured'],
    ['tsv', 'structured'],
    ['txt', 'plain'],
    ['ini', 'plain'],
    ['env', 'plain'],
    ['log', 'plain'],
  ];
  for (const [fmt, expected] of table) {
    it(`getCategory('${fmt}') === '${expected}'`, () => {
      expect(getCategory(fmt)).toBe(expected);
    });
  }
});

describe('isBuiltinEditable — 与 getFileFormat 一致', () => {
  const supported = [
    'a.json',
    'a.yaml',
    'a.xml',
    'a.toml',
    'a.csv',
    'a.tsv',
    'a.jsonl',
    'a.txt',
    'a.ini',
    'a.log',
    '.env',
    '.env.local',
    'a.md',
  ];
  for (const p of supported) {
    it(`isBuiltinEditable('${p}') === true`, () => {
      expect(isBuiltinEditable(p)).toBe(true);
    });
  }
  const unsupported = ['a.py', 'a.png', 'a.pdf', 'a.java', 'Makefile'];
  for (const p of unsupported) {
    it(`isBuiltinEditable('${p}') === false（走系统打开）`, () => {
      expect(isBuiltinEditable(p)).toBe(false);
    });
  }
});

describe('isRemoteLinkPath — .url 远程链接判定（v0.0.263）', () => {
  const remote = ['link.url', 'shortcut.URL', 'dir/sub/link.url', 'a.Url'];
  for (const p of remote) {
    it(`isRemoteLinkPath('${p}') === true`, () => {
      expect(isRemoteLinkPath(p)).toBe(true);
    });
  }
  const local = ['a.md', 'a.py', 'a.txt', 'Makefile', 'a.url.txt', ''];
  for (const p of local) {
    it(`isRemoteLinkPath('${p}') === false`, () => {
      expect(isRemoteLinkPath(p)).toBe(false);
    });
  }
});

describe('isImagePath — image 6 格式判定（v0.0.269）', () => {
  const images = ['a.png', 'a.jpg', 'a.jpeg', 'a.gif', 'a.webp', 'a.svg', 'dir/sub/logo.PNG', 'photo.JpEg'];
  for (const p of images) {
    it(`isImagePath('${p}') === true`, () => {
      expect(isImagePath(p)).toBe(true);
    });
  }
  const non = ['a.txt', 'a.png.txt', 'a.zip', 'a.bmp', 'a.tiff', 'a.ico', 'Makefile', 'a.md', '.env', ''];
  for (const p of non) {
    it(`isImagePath('${p}') === false`, () => {
      expect(isImagePath(p)).toBe(false);
    });
  }
});

describe('looksBinary — 二进制内容判定（v0.0.263）', () => {
  it('纯文本 → false', () => {
    expect(looksBinary('hello world')).toBe(false);
    expect(looksBinary('')).toBe(false);
  });
  it('含 NUL（\\u0000）占比 >5% → true（二进制）', () => {
    // 20 字符中 2 个 NUL = 10% > 5%
    expect(looksBinary('a\u0000b\u0000' + 'x'.repeat(16))).toBe(true);
  });
  it('少量替换符（≤5%）→ false（文本容忍）', () => {
    // 100 字符中 1 个 \uFFFD = 1% ≤ 5%
    expect(looksBinary('a\uFFFD' + 'x'.repeat(98))).toBe(false);
  });
  it('大量替换符（>5%）→ true（二进制/乱码）', () => {
    expect(looksBinary('\uFFFD'.repeat(3) + 'x'.repeat(40))).toBe(true);
  });
});
