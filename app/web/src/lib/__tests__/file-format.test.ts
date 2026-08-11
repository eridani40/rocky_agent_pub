/**
 * file-format 单测 —— getFileFormat 白名单覆盖（v0.0.328 扩充）
 * 参考: specs/tech/version_logs/v0.0.328/change_plan.md D1
 *       states/v0.0.328/task.json acceptanceCriteria
 */
import { describe, it, expect } from 'vitest';
import { getFileFormat, getCategory } from '../file-format';

describe('getFileFormat — 既有格式回归', () => {
  it('.json/.yaml/.xml/.md 等查表命中', () => {
    expect(getFileFormat('a.json')).toBe('json');
    expect(getFileFormat('b.yaml')).toBe('yaml');
    expect(getFileFormat('c.yml')).toBe('yaml');
    expect(getFileFormat('d.xml')).toBe('xml');
    expect(getFileFormat('e.md')).toBe('md');
    expect(getFileFormat('f.txt')).toBe('txt');
    expect(getFileFormat('g.py')).toBe('code');
  });

  it('.env 系列 → env（回归保护）', () => {
    expect(getFileFormat('.env')).toBe('env');
    expect(getFileFormat('.env.local')).toBe('env');
    expect(getFileFormat('.env.production')).toBe('env');
    expect(getFileFormat('.env.example')).toBe('env');
  });

  it('[v0.0.328 bugfix] `*.env` 后缀文件 → env（prod.env/dev.env/test.env 等，后缀是 .env）', () => {
    // 老板实测 bug：prod.env 这类「后缀是 .env」的文件点开后弹系统应用（VSCode），
    // 因 .env 不在 EXT_TO_FORMAT 查表 → getFileFormat 返 null → 走系统打开。修复：查表加 .env → env。
    expect(getFileFormat('prod.env')).toBe('env');
    expect(getFileFormat('dev.env')).toBe('env');
    expect(getFileFormat('test.env')).toBe('env');
    expect(getFileFormat('config.env')).toBe('env');
    expect(getFileFormat('my.app.env')).toBe('env'); // 多段后缀，最后一个 .env 命中
    expect(getFileFormat('PROD.ENV')).toBe('env'); // 大小写不敏感
    // 边界：prod.env.example 后缀是 .example（非 .env）→ txt；.envrc 后缀 .envrc 不在表 → null
    expect(getFileFormat('prod.env.example')).toBe('txt');
    expect(getFileFormat('.envrc')).toBeNull();
  });

  it('大小写不敏感', () => {
    expect(getFileFormat('APP.JSON')).toBe('json');
    expect(getFileFormat('Dockerfile')).toBe('txt');
    expect(getFileFormat('DOCKERFILE')).toBe('txt');
  });
});

describe('getFileFormat — [v0.0.328] KNOWN_TEXT_BASENAMES 精确匹配', () => {
  it('Dockerfile → txt', () => {
    expect(getFileFormat('Dockerfile')).toBe('txt');
    expect(getFileFormat('src/Dockerfile')).toBe('txt');
  });

  it('Makefile → txt', () => {
    expect(getFileFormat('Makefile')).toBe('txt');
  });

  it('LICENSE/CHANGELOG/README → txt', () => {
    expect(getFileFormat('LICENSE')).toBe('txt');
    expect(getFileFormat('CHANGELOG')).toBe('txt');
    expect(getFileFormat('README')).toBe('txt');
  });

  it('.gitignore/.gitattributes/.editorconfig → txt', () => {
    expect(getFileFormat('.gitignore')).toBe('txt');
    expect(getFileFormat('.gitattributes')).toBe('txt');
    expect(getFileFormat('.editorconfig')).toBe('txt');
  });

  it('.eslintrc/.prettierrc/.npmignore/.dockerignore → txt', () => {
    expect(getFileFormat('.eslintrc')).toBe('txt');
    expect(getFileFormat('.prettierrc')).toBe('txt');
    expect(getFileFormat('.npmignore')).toBe('txt');
    expect(getFileFormat('.dockerignore')).toBe('txt');
  });
});

describe('getFileFormat — [v0.0.328] EXT_TO_FORMAT 新增扩展名', () => {
  it('.example → txt', () => {
    expect(getFileFormat('config.example')).toBe('txt');
    expect(getFileFormat('.env.example')).toBe('env'); // .env 前缀优先
  });

  it('.sample → txt', () => {
    expect(getFileFormat('data.sample')).toBe('txt');
  });

  it('.lock → txt', () => {
    expect(getFileFormat('yarn.lock')).toBe('txt');
    expect(getFileFormat('package-lock.jsonl')).toBe('jsonl'); // .jsonl 命中先于 stem
  });

  it('.diff/.patch → txt', () => {
    expect(getFileFormat('fix.diff')).toBe('txt');
    expect(getFileFormat('hotfix.patch')).toBe('txt');
  });

  it('[v0.0.328 bugfix] .properties/.conf/.cfg → txt（配置文本后缀，防弹系统打开）', () => {
    expect(getFileFormat('application.properties')).toBe('txt');
    expect(getFileFormat('nginx.conf')).toBe('txt');
    expect(getFileFormat('settings.cfg')).toBe('txt');
    expect(getFileFormat('dir/sub/app.properties')).toBe('txt'); // 带路径
    expect(getFileFormat('APP.CONF')).toBe('txt'); // 大小写不敏感
  });

  it('[v0.0.328 bugfix] 多扩展名边界：.user.config.json 不误判为 txt/.conf', () => {
    // 取最后一个 . 之后的后缀查表：.user.config.json → .json（structured），非 .cfg/.conf
    expect(getFileFormat('app.user.config.json')).toBe('json');
    expect(getFileFormat('config.json')).toBe('json');
    // .conf 命中但多扩展名取最后段：x.conf.bak → .bak 不在表 → null（不误判为 conf）
    expect(getFileFormat('x.conf.bak')).toBeNull();
    // prod.env.example → .example 命中 txt（.env 前缀分支不触发：basename 非 .env 开头）
    expect(getFileFormat('prod.env.example')).toBe('txt');
  });
});

describe('getFileFormat — [v0.0.328] KNOWN_TEXT_STEMS 词干 fallback', () => {
  it('Dockerfile.dev → txt（stem=dockerfile）', () => {
    expect(getFileFormat('Dockerfile.dev')).toBe('txt');
  });

  it('LICENSE.txt 已被 .txt 命中（不截胡为 stem 路径）', () => {
    expect(getFileFormat('LICENSE.txt')).toBe('txt');
  });

  it('README.md 已被 .md 命中（不截胡为 stem 路径）', () => {
    expect(getFileFormat('README.md')).toBe('md');
  });
});

describe('getFileFormat — 二进制/未知 → null（不误判）', () => {
  it('.exe/.zip/.so → null', () => {
    expect(getFileFormat('app.exe')).toBeNull();
    expect(getFileFormat('archive.zip')).toBeNull();
    expect(getFileFormat('lib.so')).toBeNull();
  });

  it('.png/.jpg → null（image 不走 getFileFormat）', () => {
    expect(getFileFormat('logo.png')).toBeNull();
    expect(getFileFormat('photo.jpg')).toBeNull();
  });

  it('无扩展名未命中白名单 → null', () => {
    expect(getFileFormat('unknown-binary')).toBeNull();
  });
});

describe('getCategory — txt 分类回归', () => {
  it('txt → plain', () => {
    expect(getCategory('txt')).toBe('plain');
  });

  it('env → plain', () => {
    expect(getCategory('env')).toBe('plain');
  });
});
