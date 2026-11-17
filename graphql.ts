// graphql.ts — a hand-written GraphQL executor for the forge's v4 surface.
// No library: the query language subset the suite sends (operations, aliases,
// arguments, variables, inline fragments, __type introspection) is parsed
// and executed against the store. Unknown fields answer HTTP 200 with an
// `errors` entry naming the field; unknown repositories answer data null;
// unauthenticated requests are 401; batched bodies (JSON arrays) answer in order.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { VIEWER, USERS_BY_LOGIN } from './scenario.ts';
import { parseCommit, parseTree } from './gitobj.ts';
import {
  diffTrees, getObject, gid, mergeBase, pullMergeable, squashMerge, ungid,
  type Issue, type Pull, type Repo, type Store,
} from './store.ts';

export interface GraphQLCtx {
  store: Store;
  token: string;
}

const JSON_TYPE = 'application/json; charset=utf-8';

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

// ---------------------------------------------------------------- parser

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: Array<{ name: string; value: ValueNode }> };

interface FieldNode {
  kind: 'field';
  alias: string | null;
  name: string;
  args: Array<{ name: string; value: ValueNode }>;
  selectionSet: SelectionNode[] | null;
}
interface InlineFragmentNode {
  kind: 'inline';
  typeCondition: string | null;
  selectionSet: SelectionNode[];
}
interface FragmentSpreadNode {
  kind: 'spread';
  name: string;
}
type SelectionNode = FieldNode | InlineFragmentNode | FragmentSpreadNode;

interface OperationNode {
  type: 'query' | 'mutation';
  name: string | null;
  variableDefinitions: Array<{ name: string; defaultValue: ValueNode | null }>;
  selectionSet: SelectionNode[];
}

interface DocumentNode {
  operations: OperationNode[];
  fragments: Map<string, { typeCondition: string; selectionSet: SelectionNode[] }>;
}

class ParseError extends Error {}

class Lexer {
  private pos = 0;
  private readonly src: string;
  constructor(src: string) {
    this.src = src;
  }
  private skipIgnored(): void {
    for (;;) {
      while (this.pos < this.src.length && /[\s,]/.test(this.src[this.pos])) this.pos += 1;
      if (this.src[this.pos] === '#') {
        while (this.pos < this.src.length && this.src[this.pos] !== '\n') this.pos += 1;
        continue;
      }
      return;
    }
  }
  peek(): string {
    this.skipIgnored();
    return this.src[this.pos] ?? '';
  }
  next(): string {
    this.skipIgnored();
    if (this.pos >= this.src.length) throw new ParseError('unexpected end of document');
    const ch = this.src[this.pos];
    if (ch === '.' && this.src.slice(this.pos, this.pos + 3) === '...') {
      this.pos += 3;
      return '...';
    }
    if ('{}():!=$@[]'.includes(ch)) {
      this.pos += 1;
      return ch;
    }
    if (ch === '"') {
      let out = '';
      this.pos += 1;
      while (this.pos < this.src.length && this.src[this.pos] !== '"') {
        if (this.src[this.pos] === '\\') {
          this.pos += 1;
          const esc = this.src[this.pos];
          if (esc === 'n') out += '\n';
          else if (esc === 't') out += '\t';
          else if (esc === 'r') out += '\r';
          else if (esc === '"') out += '"';
          else if (esc === '\\') out += '\\';
          else if (esc === '/') out += '/';
          else if (esc === 'u') {
            out += String.fromCharCode(parseInt(this.src.slice(this.pos + 1, this.pos + 5), 16));
            this.pos += 4;
          } else out += esc;
          this.pos += 1;
        } else {
          out += this.src[this.pos];
          this.pos += 1;
        }
      }
      this.pos += 1;
      return JSON.stringify(out); // marker: a quoted JSON string
    }
    if (/[0-9-]/.test(ch)) {
      let num = '';
      while (this.pos < this.src.length && /[0-9.eE+-]/.test(this.src[this.pos])) {
        num += this.src[this.pos];
        this.pos += 1;
      }
      return `num:${num}`;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let name = '';
      while (this.pos < this.src.length && /[A-Za-z0-9_]/.test(this.src[this.pos])) {
        name += this.src[this.pos];
        this.pos += 1;
      }
      return `name:${name}`;
    }
    throw new ParseError(`unexpected character ${JSON.stringify(ch)}`);
  }
  expect(tok: string): void {
    const got = this.next();
    if (got !== tok) throw new ParseError(`expected ${tok}, got ${got}`);
  }
}

function isStringToken(tok: string): boolean {
  return tok.startsWith('"');
}
function stringValue(tok: string): string {
  return JSON.parse(tok) as string;
}

class Parser {
  private readonly lex: Lexer;
  constructor(src: string) {
    this.lex = new Lexer(src);
  }
  parseDocument(): DocumentNode {
    const doc: DocumentNode = { operations: [], fragments: new Map() };
    while (this.lex.peek() !== '') {
      const tok = this.lex.next();
      if (tok === '{') {
        doc.operations.push({ type: 'query', name: null, variableDefinitions: [], selectionSet: this.parseSelectionSetRest() });
      } else if (tok === 'name:query' || tok === 'name:mutation') {
        const type = tok === 'name:query' ? 'query' : 'mutation';
        let name: string | null = null;
        if (this.lex.peek() !== '(' && this.lex.peek() !== '{' && this.lex.peek() !== '@') {
          const nt = this.lex.next();
          if (nt.startsWith('name:')) name = nt.slice(5);
          else throw new ParseError('expected operation name');
        }
        const varDefs = this.lex.peek() === '(' ? this.parseVariableDefinitions() : [];
        this.skipDirectives();
        this.lex.expect('{');
        doc.operations.push({ type, name, variableDefinitions: varDefs, selectionSet: this.parseSelectionSetRest() });
      } else if (tok === 'name:fragment') {
        const nt = this.lex.next();
        if (!nt.startsWith('name:')) throw new ParseError('expected fragment name');
        const fragName = nt.slice(5);
        const on = this.lex.next();
        if (on !== 'name:on') throw new ParseError('expected "on"');
        const tt = this.lex.next();
        if (!tt.startsWith('name:')) throw new ParseError('expected fragment type');
        this.skipDirectives();
        this.lex.expect('{');
        doc.fragments.set(fragName, { typeCondition: tt.slice(5), selectionSet: this.parseSelectionSetRest() });
      } else {
        throw new ParseError(`unexpected definition ${tok}`);
      }
    }
    return doc;
  }
  private parseVariableDefinitions(): Array<{ name: string; defaultValue: ValueNode | null }> {
    this.lex.expect('(');
    const defs: Array<{ name: string; defaultValue: ValueNode | null }> = [];
    while (this.lex.peek() !== ')') {
      this.lex.expect('$');
      const nt = this.lex.next();
      if (!nt.startsWith('name:')) throw new ParseError('expected variable name');
      const varName = nt.slice(5);
      // Skip the type (names, [, ], !) until '=', ',' or ')' at depth 0.
      let depth = 0;
      let done = false;
      while (!done) {
        const t = this.lex.next();
        if (t === '[' || t === '{') depth += 1;
        else if (t === ']' || t === '}') depth -= 1;
        else if (depth === 0 && t === '=') {
          const def = this.parseValue();
          defs.push({ name: varName, defaultValue: def });
          done = true;
        } else if (depth === 0 && t === ',') {
          defs.push({ name: varName, defaultValue: null });
          done = true;
        } else if (depth === 0 && t === ')') {
          defs.push({ name: varName, defaultValue: null });
          return defs;
        }
      }
      if (this.lex.peek() === ',') this.lex.next();
    }
    this.lex.expect(')');
    return defs;
  }
  private skipDirectives(): void {
    while (this.lex.peek() === '@') {
      this.lex.next();
      const nt = this.lex.next();
      if (!nt.startsWith('name:')) throw new ParseError('expected directive name');
      if (this.lex.peek() === '(') {
        this.lex.next();
        let depth = 1;
        while (depth > 0) {
          const t = this.lex.next();
          if (t === '(' || t === '[' || t === '{') depth += 1;
          else if (t === ')' || t === ']' || t === '}') depth -= 1;
        }
      }
    }
  }
  private parseSelectionSetRest(): SelectionNode[] {
    const selections: SelectionNode[] = [];
    while (this.lex.peek() !== '}') {
      selections.push(this.parseSelection());
    }
    this.lex.expect('}');
    return selections;
  }
  private parseSelection(): SelectionNode {
    const tok = this.lex.next();
    if (tok === '...') {
      const next = this.lex.next();
      if (next === 'name:on') {
        const tt = this.lex.next();
        if (!tt.startsWith('name:')) throw new ParseError('expected inline fragment type');
        this.skipDirectives();
        this.lex.expect('{');
        return { kind: 'inline', typeCondition: tt.slice(5), selectionSet: this.parseSelectionSetRest() };
      }
      if (next.startsWith('name:')) {
        this.skipDirectives();
        return { kind: 'spread', name: next.slice(5) };
      }
      throw new ParseError('expected fragment spread or inline fragment');
    }
    if (!tok.startsWith('name:')) throw new ParseError(`expected field name, got ${tok}`);
    let alias: string | null = null;
    let name = tok.slice(5);
    if (this.lex.peek() === ':') {
      this.lex.next();
      alias = name;
      const nt = this.lex.next();
      if (!nt.startsWith('name:')) throw new ParseError('expected field name after alias');
      name = nt.slice(5);
    }
    const args: Array<{ name: string; value: ValueNode }> = [];
    if (this.lex.peek() === '(') {
      this.lex.next();
      while (this.lex.peek() !== ')') {
        const nt = this.lex.next();
        if (!nt.startsWith('name:')) throw new ParseError('expected argument name');
        this.lex.expect(':');
        args.push({ name: nt.slice(5), value: this.parseValue() });
      }
      this.lex.expect(')');
    }
    this.skipDirectives();
    let selectionSet: SelectionNode[] | null = null;
    if (this.lex.peek() === '{') {
      this.lex.next();
      selectionSet = this.parseSelectionSetRest();
    }
    return { kind: 'field', alias, name, args, selectionSet };
  }
  private parseValue(): ValueNode {
    const tok = this.lex.next();
    if (tok === '$') {
      const nt = this.lex.next();
      if (!nt.startsWith('name:')) throw new ParseError('expected variable name');
      return { kind: 'variable', name: nt.slice(5) };
    }
    if (tok.startsWith('num:')) {
      const raw = tok.slice(4);
      return raw.includes('.') || raw.includes('e') || raw.includes('E')
        ? { kind: 'float', value: parseFloat(raw) }
        : { kind: 'int', value: parseInt(raw, 10) };
    }
    if (isStringToken(tok)) return { kind: 'string', value: stringValue(tok) };
    if (tok === '[') {
      const values: ValueNode[] = [];
      while (this.lex.peek() !== ']') values.push(this.parseValue());
      this.lex.expect(']');
      return { kind: 'list', values };
    }
    if (tok === '{') {
      const fields: Array<{ name: string; value: ValueNode }> = [];
      while (this.lex.peek() !== '}') {
        const nt = this.lex.next();
        if (!nt.startsWith('name:')) throw new ParseError('expected object field name');
        this.lex.expect(':');
        fields.push({ name: nt.slice(5), value: this.parseValue() });
      }
      this.lex.expect('}');
      return { kind: 'object', fields };
    }
    if (tok.startsWith('name:')) {
      const name = tok.slice(5);
      if (name === 'true') return { kind: 'boolean', value: true };
      if (name === 'false') return { kind: 'boolean', value: false };
      if (name === 'null') return { kind: 'null' };
      return { kind: 'enum', value: name };
    }
    throw new ParseError(`unexpected value ${tok}`);
  }
}

// ---------------------------------------------------------------- execution

interface Ctx {
  store: Store;
}

type AnyObj = Record<string, unknown> & { __typename?: string };

class FieldError extends Error {
  path: Array<string | number>;
  constructor(message: string, path: Array<string | number>) {
    super(message);
    this.path = path;
  }
}

function valueOf(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable': return variables[node.name];
    case 'int': case 'float': case 'string': case 'boolean': return node.value;
    case 'null': return null;
    case 'enum': return node.value;
    case 'list': return node.values.map((v) => valueOf(v, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const f of node.fields) out[f.name] = valueOf(f.value, variables);
      return out;
    }
  }
}

function argsOf(field: FieldNode, variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const a of field.args) out[a.name] = valueOf(a.value, variables);
  return out;
}

function strArg(args: Record<string, unknown>, name: string): string | undefined {
  const v = args[name];
  return typeof v === 'string' ? v : undefined;
}
function intArg(args: Record<string, unknown>, name: string): number | undefined {
  const v = args[name];
  return typeof v === 'number' ? v : undefined;
}

// Cursor: base64("cursor:<index>") over the number-DESC ordered list.
function encodeCursor(index: number): string {
  return Buffer.from(`cursor:${index}`, 'utf8').toString('base64');
}
function decodeCursor(cursor: string | undefined): number {
  if (!cursor) return -1;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const m = text.match(/^cursor:(\d+)$/);
    return m ? parseInt(m[1], 10) : -1;
  } catch {
    return -1;
  }
}

function pageInfoFor(total: number, start: number, end: number): AnyObj {
  return {
    __typename: 'PageInfo',
    hasNextPage: end < total,
    hasPreviousPage: start > 0,
    startCursor: total === 0 || start >= total ? null : encodeCursor(start),
    endCursor: total === 0 || end <= start ? null : encodeCursor(end - 1),
  };
}

function gqlState(state: string, merged: boolean): string {
  if (merged) return 'MERGED';
  return state === 'open' ? 'OPEN' : 'CLOSED';
}

function issueObj(repo: Repo, issue: Issue): AnyObj {
  return {
    __typename: 'Issue',
    _repo: repo,
    _issue: issue,
    id: gid('issue', repo.id, issue.number),
    number: issue.number,
    title: issue.title,
    body: issue.body ?? '',
    state: gqlState(issue.state, false),
  };
}

function pullObj(repo: Repo, pull: Pull): AnyObj {
  return {
    __typename: 'PullRequest',
    _repo: repo,
    _pull: pull,
    id: gid('pull', repo.id, pull.number),
    number: pull.number,
    title: pull.title,
    body: pull.body ?? '',
    state: gqlState(pull.state, pull.merged),
    merged: pull.merged,
    headRefName: pull.head.ref,
    baseRefName: pull.base.ref,
    mergeable: pullMergeable(repo, pull),
  };
}

function repoObj(repo: Repo): AnyObj {
  return {
    __typename: 'Repository',
    _repo: repo,
    id: gid('repo', repo.id),
    databaseId: repo.id,
    name: repo.name,
    nameWithOwner: `${repo.owner}/${repo.name}`,
    viewerPermission: 'ADMIN',
    hasIssuesEnabled: true,
    owner: {
      __typename: 'User',
      login: repo.owner,
      id: repo.owner === VIEWER.login ? VIEWER.id : 1000,
      name: repo.owner,
      email: `${repo.owner}@example.invalid`,
    },
    defaultBranchRef: repo.refs.has(`refs/heads/${repo.defaultBranch}`)
      ? { __typename: 'Ref', name: repo.defaultBranch }
      : null,
  };
}

function userObj(login: string, id: number): AnyObj {
  const u = USERS_BY_LOGIN.get(login);
  return {
    __typename: 'User',
    login,
    id,
    name: u?.name ?? login,
    email: u?.email ?? `${login}@example.invalid`,
  };
}

// Introspection field tables (must include every field the suite asks for).
const TYPE_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', 'search', 'user', 'organization', 'rateLimit', 'codesOfConduct', 'licenses', 'marketplaceListings', 'meta', 'nodes', 'resource', 'topic', 'viewerCanAdminister'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment', 'createRepository', 'deleteIssue', 'updateIssue', 'addStar', 'removeStar'],
  User: ['login', 'id', 'name', 'email', 'avatarUrl', 'url', 'bio', 'company', 'createdAt', 'followers', 'following', 'isViewer', 'location', 'repositories', 'starredRepositories', 'status', 'twitterUsername', 'updatedAt', 'websiteUrl'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'createdAt', 'updatedAt', 'description', 'isPrivate', 'url', 'homepageUrl', 'forkCount', 'stargazerCount', 'watchers', 'primaryLanguage', 'licenseInfo', 'diskUsage', 'hasWikiEnabled', 'isArchived', 'isDisabled', 'isFork', 'isLocked', 'isMirror', 'isTemplate', 'issues', 'labels', 'languages', 'lockReason', 'mentionableUsers', 'mergeCommitAllowed', 'milestones', 'object', 'parent', 'projects', 'pushedAt', 'rebaseMergeAllowed', 'ref', 'refs', 'releases', 'repositoryTopics', 'resourcePath', 'shortDescriptionHTML', 'squashMergeAllowed', 'sshUrl', 'viewerCanAdminister', 'viewerHasStarred', 'assignableUsers', 'codeOfConduct', 'collaborators', 'commitComments', 'contactLinks', 'discussionCategories', 'discussions', 'fundingLinks', 'hasProjectsEnabled', 'isBlankIssuesEnabled', 'isEmpty', 'isInOrganization', 'viewerSubscription'],
  Issue: ['id', 'number', 'title', 'state', 'body', 'createdAt', 'updatedAt', 'url', 'author', 'comments', 'labels', 'assignees', 'closedAt', 'locked', 'milestone', 'repository', 'resourcePath', 'viewerCanUpdate', 'activeLockReason', 'bodyHTML', 'bodyText', 'closed', 'fullDatabaseId', 'isPinned', 'participants', 'projectCards', 'reactionGroups', 'reactions', 'stateReason', 'timelineItems', 'timelineUrl'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  IssueEdge: ['node', 'cursor'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  PullRequest: ['id', 'number', 'headRefName', 'baseRefName', 'mergeable', 'state', 'merged', 'files', 'title', 'body', 'createdAt', 'updatedAt', 'author', 'baseRef', 'headRef', 'closedAt', 'mergedAt', 'mergeCommit', 'comments', 'labels', 'repository', 'url', 'viewerCanUpdate', 'activeLockReason', 'additions', 'assignees', 'autoMergeRequest', 'baseRefName', 'baseRefOid', 'bodyHTML', 'bodyText', 'changedFiles', 'checksUrl', 'closed', 'commits', 'deletions', 'fullDatabaseId', 'headRefOid', 'isCrossRepository', 'isDraft', 'isPinned', 'labels', 'locked', 'maintainerCanModify', 'mergeStateStatus', 'mergedBy', 'milestone', 'participants', 'projectCards', 'reactionGroups', 'reactions', 'reviewDecision', 'reviewRequests', 'reviewThreads', 'reviews', 'stateReason', 'suggestedReviewers', 'timelineItems', 'timelineUrl'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestEdge: ['node', 'cursor'],
  PullRequestFileConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestFile: ['path', 'additions', 'deletions', 'changeType'],
  Ref: ['name', 'id', 'associatedPullRequests', 'prefix', 'target'],
  Comment: ['id', 'body', 'author', 'createdAt', 'updatedAt', 'url'],
  CommentEdge: ['node', 'cursor'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'clientMutationId'],
  SearchType: [],
  __Type: ['name', 'kind', 'description', 'fields', 'enumValues', 'inputFields', 'interfaces', 'possibleTypes', 'specifiedByURL'],
  __Field: ['name', 'description', 'args', 'type', 'isDeprecated', 'deprecationReason'],
  __InputValue: ['name', 'description', 'type', 'defaultValue'],
  __EnumValue: ['name', 'description', 'isDeprecated', 'deprecationReason'],
  __Schema: ['queryType', 'mutationType', 'subscriptionType', 'types', 'directives'],
};

const SEARCH_TYPE_VALUES = ['ISSUE', 'PULL_REQUEST', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'MILESTONE', 'ORGANIZATION', 'PACKAGE', 'TOPIC'];

function typeObject(name: string): AnyObj {
  return {
    __typename: '__Type',
    name,
    kind: name === 'SearchType' ? 'ENUM' : 'OBJECT',
    description: null,
    _typeName: name,
  };
}

class Executor {
  private errors: Array<{ message: string; path?: Array<string | number> }> = [];
  private readonly ctx: Ctx;
  private readonly doc: DocumentNode;
  constructor(ctx: Ctx, doc: DocumentNode) {
    this.ctx = ctx;
    this.doc = doc;
  }

  execute(op: OperationNode, variables: Record<string, unknown>): { data: Record<string, unknown>; errors?: Array<{ message: string; path?: Array<string | number> }> } {
    this.errors = [];
    const vars: Record<string, unknown> = { ...variables };
    for (const def of op.variableDefinitions) {
      if (vars[def.name] === undefined && def.defaultValue !== null) {
        vars[def.name] = valueOf(def.defaultValue, vars);
      }
    }
    const rootType = op.type === 'mutation' ? 'Mutation' : 'Query';
    const root: AnyObj = { __typename: rootType };
    const data = this.executeSelectionSet(rootType, root, op.selectionSet, vars, []);
    const out: { data: Record<string, unknown>; errors?: Array<{ message: string; path?: Array<string | number> }> } = { data };
    if (this.errors.length) out.errors = this.errors;
    return out;
  }

  private executeSelectionSet(typeName: string, obj: AnyObj, selections: SelectionNode[], vars: Record<string, unknown>, path: Array<string | number>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const sel of selections) {
      if (sel.kind === 'field') {
        const key = sel.alias ?? sel.name;
        const fieldPath = [...path, key];
        try {
          const value = this.resolveField(typeName, obj, sel, vars, fieldPath);
          out[key] = value;
        } catch (err) {
          if (err instanceof FieldError) {
            this.errors.push({ message: err.message, path: err.path });
            out[key] = null;
          } else throw err;
        }
      } else if (sel.kind === 'inline') {
        if (!sel.typeCondition || sel.typeCondition === obj.__typename) {
          Object.assign(out, this.executeSelectionSet(typeName, obj, sel.selectionSet, vars, path));
        }
      } else {
        const frag = this.doc.fragments.get(sel.name);
        if (frag && (!frag.typeCondition || frag.typeCondition === obj.__typename)) {
          Object.assign(out, this.executeSelectionSet(typeName, obj, frag.selectionSet, vars, path));
        }
      }
    }
    return out;
  }

  private resolveField(typeName: string, obj: AnyObj, field: FieldNode, vars: Record<string, unknown>, path: Array<string | number>): unknown {
    const name = field.name;
    const args = argsOf(field, vars);
    // Meta-fields.
    if (name === '__typename') return obj.__typename ?? typeName;
    if (name === '__type') {
      const tname = strArg(args, 'name');
      if (!tname || !(tname in TYPE_FIELDS)) return null;
      const typeObj = typeObject(tname);
      return field.selectionSet ? this.executeSelectionSet('__Type', typeObj, field.selectionSet, vars, path) : typeObj;
    }
    if (name === '__schema') {
      const schemaObj: AnyObj = { __typename: '__Schema' };
      return field.selectionSet ? this.executeSelectionSet('__Schema', schemaObj, field.selectionSet, vars, path) : schemaObj;
    }

    const known = TYPE_FIELDS[typeName] ?? [];
    if (!known.includes(name)) {
      throw new FieldError(`Cannot query field "${name}" on type "${typeName}".`, path);
    }
    if (!field.selectionSet) {
      return this.resolveScalar(typeName, obj, name, args, path);
    }
    const value = this.resolveObject(typeName, obj, name, args, path);
    if (value === null || value === undefined) return null;
    if (Array.isArray(value)) {
      return value.map((item, i) =>
        item !== null && typeof item === 'object'
          ? this.executeSelectionSet((item as AnyObj).__typename ?? typeName, item as AnyObj, field.selectionSet!, vars, [...path, i])
          : item,
      );
    }
    if (typeof value === 'object') {
      return this.executeSelectionSet((value as AnyObj).__typename ?? typeName, value as AnyObj, field.selectionSet, vars, path);
    }
    return value;
  }

  private resolveScalar(typeName: string, obj: AnyObj, name: string, args: Record<string, unknown>, path: Array<string | number>): unknown {
    // __Type / __Field / __EnumValue / __Schema scalars.
    if (typeName === '__Type') {
      if (name === 'name') return (obj as AnyObj)._typeName ?? obj.name ?? null;
      if (name === 'kind') return obj.kind ?? 'OBJECT';
      if (name === 'description') return null;
      if (name === 'specifiedByURL') return null;
    }
    if (typeName === '__Field' || typeName === '__InputValue' || typeName === '__EnumValue') {
      if (name === 'name') return obj.name ?? null;
      if (name === 'description') return null;
      if (name === 'isDeprecated') return false;
      if (name === 'deprecationReason') return null;
      if (name === 'defaultValue') return null;
    }
    if (typeName === '__Schema') {
      return null;
    }
    if (typeName === 'PageInfo') {
      return obj[name] ?? null;
    }
    // Plain stored values.
    if (name in obj) return obj[name] as unknown;
    throw new FieldError(`Cannot query field "${name}" on type "${typeName}".`, path);
  }

  private resolveObject(typeName: string, obj: AnyObj, name: string, args: Record<string, unknown>, path: Array<string | number>): unknown {
    const store = this.ctx.store;
    // __Type introspection objects.
    if (typeName === '__Type') {
      if (name === 'fields') {
        const tname = (obj as AnyObj)._typeName as string;
        return (TYPE_FIELDS[tname] ?? []).map((f) => ({ __typename: '__Field', name: f }));
      }
      if (name === 'enumValues') {
        const tname = (obj as AnyObj)._typeName as string;
        if (tname !== 'SearchType') return [];
        return SEARCH_TYPE_VALUES.map((v) => ({ __typename: '__EnumValue', name: v }));
      }
      if (name === 'inputFields' || name === 'interfaces' || name === 'possibleTypes') return [];
      return null;
    }
    if (typeName === '__Schema') {
      if (name === 'queryType') return typeObject('Query');
      if (name === 'mutationType') return typeObject('Mutation');
      if (name === 'subscriptionType') return null;
      if (name === 'types') return Object.keys(TYPE_FIELDS).map((t) => typeObject(t));
      if (name === 'directives') return [];
      return null;
    }
    if (typeName === '__Field' || typeName === '__InputValue') {
      if (name === 'args' || name === 'type') return null;
      return null;
    }

    if (typeName === 'Query') {
      if (name === 'viewer') return userObj(VIEWER.login, VIEWER.id);
      if (name === 'repository') {
        const owner = strArg(args, 'owner');
        const repoName = strArg(args, 'name');
        if (!owner || !repoName || owner !== VIEWER.login) return null;
        const repo = store.getRepo(owner, repoName);
        return repo ? repoObj(repo) : null;
      }
      if (name === 'node') {
        const id = strArg(args, 'id');
        if (!id) return null;
        const decoded = ungid(id);
        if (!decoded) return null;
        if (decoded.kind === 'repo') {
          const repo = store.getRepoById(parseInt(decoded.parts[0], 10));
          return repo ? repoObj(repo) : null;
        }
        if (decoded.kind === 'issue') {
          const repo = store.getRepoById(parseInt(decoded.parts[0], 10));
          const issue = repo?.issues.find((i) => i.number === parseInt(decoded.parts[1], 10));
          return repo && issue ? issueObj(repo, issue) : null;
        }
        if (decoded.kind === 'pull') {
          const repo = store.getRepoById(parseInt(decoded.parts[0], 10));
          const pull = repo?.pulls.find((p) => p.number === parseInt(decoded.parts[1], 10));
          return repo && pull ? pullObj(repo, pull) : null;
        }
        if (decoded.kind === 'user') {
          return userObj(decoded.parts[0], 1000);
        }
        return null;
      }
      return null;
    }

    if (typeName === 'Mutation') {
      return this.resolveMutation(name, args, path);
    }

    if (typeName === 'Repository') {
      const repo = (obj as AnyObj)._repo as Repo;
      if (name === 'owner') return obj.owner;
      if (name === 'defaultBranchRef') return obj.defaultBranchRef;
      if (name === 'issue') {
        const num = intArg(args, 'number');
        const issue = repo.issues.find((i) => i.number === num);
        return issue ? issueObj(repo, issue) : null;
      }
      if (name === 'issues') {
        const first = intArg(args, 'first');
        const after = strArg(args, 'after');
        const states = Array.isArray(args.states) ? (args.states as string[]) : undefined;
        const orderBy = isRecord(args.orderBy) ? (args.orderBy as Record<string, unknown>) : undefined;
        let list = [...repo.issues];
        if (states && states.length) {
          list = list.filter((i) => states.includes(gqlState(i.state, false)));
        }
        // CREATED_AT DESC (ties: number DESC) is the suite's order; ASC reverses.
        const desc = !(orderBy && String(orderBy.direction ?? '') === 'ASC');
        list.sort((a, b) => (desc ? b.number - a.number : a.number - b.number));
        const start = decodeCursor(after) + 1;
        const end = first === undefined ? list.length : Math.min(list.length, start + first);
        const nodes = list.slice(start, end).map((i) => issueObj(repo, i));
        return {
          __typename: 'IssueConnection',
          nodes,
          pageInfo: pageInfoFor(list.length, start, end),
          totalCount: list.length,
        };
      }
      if (name === 'pullRequests') {
        const first = intArg(args, 'first');
        const list = [...repo.pulls].sort((a, b) => b.number - a.number);
        const end = first === undefined ? list.length : Math.min(list.length, first);
        return {
          __typename: 'PullRequestConnection',
          nodes: list.slice(0, end).map((p) => pullObj(repo, p)),
          pageInfo: pageInfoFor(list.length, 0, end),
          totalCount: list.length,
        };
      }
      if (name === 'pullRequest') {
        const num = intArg(args, 'number');
        const pull = repo.pulls.find((p) => p.number === num);
        return pull ? pullObj(repo, pull) : null;
      }
      return null;
    }

    if (typeName === 'IssueConnection' || typeName === 'PullRequestConnection' || typeName === 'PullRequestFileConnection') {
      if (name === 'nodes') return obj.nodes as unknown[];
      if (name === 'edges') {
        return ((obj.nodes as AnyObj[]) ?? []).map((n, i) => ({ __typename: 'IssueEdge', node: n, cursor: encodeCursor(i) }));
      }
      if (name === 'pageInfo') return obj.pageInfo;
      if (name === 'totalCount') return obj.totalCount ?? null;
      return null;
    }

    if (typeName === 'PullRequest') {
      const repo = (obj as AnyObj)._repo as Repo;
      const pull = (obj as AnyObj)._pull as Pull;
      if (name === 'files') {
        const first = intArg(args, 'first');
        const base = mergeBase(repo, pull.head.sha, pull.base.sha);
        const headTree = parseCommit(getObject(repo, pull.head.sha)!.data).tree;
        const baseTree = base ? parseCommit(getObject(repo, base)!.data).tree : null;
        const diffs = diffTrees(repo, baseTree, headTree);
        const nodes = diffs.map((d) => ({ __typename: 'PullRequestFile', path: d.path, additions: 0, deletions: 0, changeType: d.status }));
        const end = first === undefined ? nodes.length : Math.min(nodes.length, first);
        return {
          __typename: 'PullRequestFileConnection',
          nodes: nodes.slice(0, end),
          pageInfo: pageInfoFor(nodes.length, 0, end),
          totalCount: nodes.length,
        };
      }
      return null;
    }

    if (typeName === 'AddCommentPayload') {
      if (name === 'commentEdge') return obj.commentEdge;
      return null;
    }
    if (typeName === 'CommentEdge' || typeName === 'IssueEdge' || typeName === 'PullRequestEdge') {
      if (name === 'node') return obj.node;
      if (name === 'cursor') return obj.cursor ?? null;
      return null;
    }
    if (typeName === 'CreateIssuePayload' || typeName === 'CloseIssuePayload') {
      if (name === 'issue') return obj.issue;
      return null;
    }
    if (typeName === 'CreatePullRequestPayload' || typeName === 'MergePullRequestPayload') {
      if (name === 'pullRequest') return obj.pullRequest;
      return null;
    }
    return null;
  }

  private resolveMutation(name: string, args: Record<string, unknown>, path: Array<string | number>): unknown {
    const store = this.ctx.store;
    const input = isRecord(args.input) ? (args.input as Record<string, unknown>) : {};
    if (name === 'createIssue') {
      const repoId = ungid(String(input.repositoryId ?? ''));
      const repo = repoId?.kind === 'repo' ? store.getRepoById(parseInt(repoId.parts[0], 10)) : undefined;
      if (!repo) throw new FieldError('Repository not found.', path);
      const issue: Issue = {
        number: repo.nextIssue++,
        title: typeof input.title === 'string' ? input.title : '',
        body: typeof input.body === 'string' ? input.body : '',
        state: 'open',
        labels: [],
        user: VIEWER.login,
        seq: store.nextSeq(),
        comments: [],
      };
      repo.issues.push(issue);
      return { __typename: 'CreateIssuePayload', issue: issueObj(repo, issue) };
    }
    if (name === 'closeIssue') {
      const decoded = ungid(String(input.issueId ?? ''));
      const repo = decoded?.kind === 'issue' ? store.getRepoById(parseInt(decoded.parts[0], 10)) : undefined;
      const issue = repo?.issues.find((i) => i.number === parseInt(decoded?.parts[1] ?? 'NaN', 10));
      if (!repo || !issue) throw new FieldError('Issue not found.', path);
      issue.state = 'closed';
      return { __typename: 'CloseIssuePayload', issue: issueObj(repo, issue) };
    }
    if (name === 'createPullRequest') {
      const repoId = ungid(String(input.repositoryId ?? ''));
      const repo = repoId?.kind === 'repo' ? store.getRepoById(parseInt(repoId.parts[0], 10)) : undefined;
      if (!repo) throw new FieldError('Repository not found.', path);
      const head = typeof input.headRefName === 'string' ? input.headRefName : '';
      const base = typeof input.baseRefName === 'string' ? input.baseRefName : '';
      const headSha = repo.refs.get(`refs/heads/${head}`);
      const baseSha = repo.refs.get(`refs/heads/${base}`);
      if (!headSha || !baseSha) throw new FieldError('Head or base branch not found.', path);
      const existing = repo.pulls.find((p) => p.state === 'open' && p.head.ref === head && p.base.ref === base);
      if (existing) return { __typename: 'CreatePullRequestPayload', pullRequest: pullObj(repo, existing) };
      const pull: Pull = {
        number: repo.nextPull++,
        title: typeof input.title === 'string' ? input.title : '',
        body: typeof input.body === 'string' ? input.body : '',
        state: 'open',
        head: { ref: head, sha: headSha },
        base: { ref: base, sha: baseSha },
        merged: false,
        mergedAt: null,
        mergeCommitSha: null,
        user: VIEWER.login,
        seq: store.nextSeq(),
        comments: [],
      };
      repo.pulls.push(pull);
      return { __typename: 'CreatePullRequestPayload', pullRequest: pullObj(repo, pull) };
    }
    if (name === 'mergePullRequest') {
      const decoded = ungid(String(input.pullRequestId ?? ''));
      const repo = decoded?.kind === 'pull' ? store.getRepoById(parseInt(decoded.parts[0], 10)) : undefined;
      const pull = repo?.pulls.find((p) => p.number === parseInt(decoded?.parts[1] ?? 'NaN', 10));
      if (!repo || !pull) throw new FieldError('Pull request not found.', path);
      const merged = squashMerge(repo, store, pull);
      if (!merged.ok) throw new FieldError(merged.reason, path);
      return { __typename: 'MergePullRequestPayload', pullRequest: pullObj(repo, pull) };
    }
    if (name === 'addComment') {
      const decoded = ungid(String(input.subjectId ?? ''));
      if (!decoded) throw new FieldError('Subject not found.', path);
      const repo = store.getRepoById(parseInt(decoded.parts[0], 10));
      if (!repo) throw new FieldError('Subject not found.', path);
      const body = typeof input.body === 'string' ? input.body : '';
      const comment = {
        id: repo.nextComment++,
        body,
        user: VIEWER.login,
        seq: store.nextSeq(),
      };
      let target: Issue | Pull | undefined;
      if (decoded.kind === 'issue') target = repo.issues.find((i) => i.number === parseInt(decoded.parts[1], 10));
      else if (decoded.kind === 'pull') target = repo.pulls.find((p) => p.number === parseInt(decoded.parts[1], 10));
      if (!target) throw new FieldError('Subject not found.', path);
      target.comments.push(comment);
      return {
        __typename: 'AddCommentPayload',
        commentEdge: {
          __typename: 'CommentEdge',
          node: { __typename: 'Comment', id: gid('comment', repo.id, target.number, comment.id), body },
          cursor: encodeCursor(0),
        },
      };
    }
    throw new FieldError(`Cannot query field "${name}" on type "Mutation".`, path);
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export async function handleGraphQL(ctx: GraphQLCtx, req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const url = req.url ?? '/';
  if (!url.startsWith('/api/graphql')) return false;
  if ((req.method ?? 'GET') !== 'POST') {
    sendJson(res, 405, { message: 'Method Not Allowed' });
    return true;
  }
  if (ctx.token && (req.headers.authorization ?? '') !== `Bearer ${ctx.token}`) {
    sendJson(res, 401, { message: 'Requires authentication' });
    return true;
  }
  let raw: Buffer;
  try {
    raw = await readBody(req);
  } catch {
    sendJson(res, 400, { errors: [{ message: 'could not read request body' }] });
    return true;
  }
  let body: unknown;
  try {
    body = JSON.parse(raw.toString('utf8'));
  } catch {
    sendJson(res, 400, { errors: [{ message: 'Problems parsing JSON' }] });
    return true;
  }
  const operations = Array.isArray(body) ? body : [body];
  const results: unknown[] = [];
  for (const opBody of operations) {
    if (!isRecord(opBody) || typeof opBody.query !== 'string') {
      results.push({ errors: [{ message: 'A query document is required.' }] });
      continue;
    }
    const variables = isRecord(opBody.variables) ? (opBody.variables as Record<string, unknown>) : {};
    let doc: DocumentNode;
    try {
      doc = new Parser(opBody.query).parseDocument();
    } catch (err) {
      results.push({ errors: [{ message: err instanceof Error ? err.message : 'GraphQL parse error' }] });
      continue;
    }
    const opName = typeof opBody.operationName === 'string' ? opBody.operationName : null;
    const op = opName
      ? doc.operations.find((o) => o.name === opName)
      : doc.operations[0];
    if (!op) {
      results.push({ errors: [{ message: `Unknown operation named "${opName}".` }] });
      continue;
    }
    try {
      const executor = new Executor(ctx, doc);
      results.push(executor.execute(op, variables));
    } catch (err) {
      results.push({ errors: [{ message: err instanceof Error ? err.message : 'execution error' }] });
    }
  }
  sendJson(res, 200, Array.isArray(body) ? results : results[0]);
  return true;
}
