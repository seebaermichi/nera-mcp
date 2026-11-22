// The write tools of the hosted mode (L7b, plan D2–D5): `write_page`,
// `write_file` and `delete_page` on the signed-in user's GitHub repositories.
// Each call makes exactly one commit, with the message the model passes, on
// the draft branch `nera-draft`; the first write creates it from `main`. The
// deploy workflow only runs on pushes to `main`, so nothing goes live until
// `publish` merges the draft. The page and path rules are the local mode's
// (src/pages.js); the site lookup is the read tools' (`createSiteAccess`).
import path from 'node:path'
import { z } from 'zod'
import { NO_WRITE_SEGMENTS, composePage, refuseSecrets, refuseSegments, requireLayout } from '../../pages.js'
import { ok, ToolError } from '../../results.js'
import { DRAFT_BRANCH, commitMessage, repoPath } from '../repo.js'
import {
    MAX_READ_BYTES,
    SYMLINK_MODE,
    createSiteAccess,
    fileInput,
    hostedSiteInput,
    hostedTool,
    pageInput,
    repoFolder,
    requirePagePath,
} from './read.js'

const messageInput = z
    .string()
    .describe('The commit message: one line saying what the change does, e.g. "Add the about page" or "Fix a typo on the home page". Each call makes one commit with it.')

/** What every successful write tells the model to do next. */
const NEXT = `Nothing is live yet: the change waits on the draft branch ${DRAFT_BRANCH}. Call validate to check the site, then publish to put the draft live.`

/**
 * Refuses a path the repository's tree cannot take as a file: one below a
 * symbolic link or below a file. The path itself being a link is caught when
 * it is read.
 *
 * @param {Array<{path: string, type: string, mode: string}>} entries the tree at the read ref
 * @param {string} file a repository path
 * @throws {ToolError}
 */
export function refuseBlockedPath(entries, file) {
    const segments = file.split('/')
    for (let i = 1; i < segments.length; i += 1) {
        const ancestor = segments.slice(0, i).join('/')
        const entry = entries.find((candidate) => candidate.path === ancestor)
        if (entry?.mode === SYMLINK_MODE) {
            throw new ToolError(`"${file}" is below ${ancestor}, which is a symbolic link; these tools do not follow links.`)
        }
        if (entry?.type === 'blob') {
            throw new ToolError(`"${file}" is below ${ancestor}, which is a file, not a folder.`)
        }
    }
}

/**
 * Registers the hosted write tools.
 *
 * @param {import('@modelcontextprotocol/sdk/server/mcp.js').McpServer} server
 * @param {object} ctx
 * @param {() => Promise<ReturnType<import('../repo.js').createRepoClient>>} ctx.repos the signed-in user's repository client
 */
export function registerHostedWriteTools(server, { repos }) {
    const { openSite, readAt, siteModel } = createSiteAccess(repos)

    /**
     * Commits one change of `file` to the draft. `decide` gets the file as it
     * is on the branch the change goes onto (the draft, or `main` before the
     * first write) and returns the new content (null: delete), or throws a
     * `ToolError`. The draft is only created once `decide` accepted the
     * change; when it then starts from a newer `main` than the one read,
     * `decide` runs again on that.
     *
     * @param {Awaited<ReturnType<typeof openSite>>} target
     * @param {string} file
     * @param {string} what how a refusal names the file ("a page")
     * @param {(current: {content: Buffer|null, size: number}|null) => string|null} decide
     * @param {string} message
     * @returns {Promise<{ current: object|null, commit: string }>}
     */
    async function commitToDraft(target, file, what, decide, message) {
        let current = await readAt(target, file, what)
        let content = decide(current)
        if (!target.draft.exists) {
            const { sha } = await target.client.ensureDraft(target.site)
            if (sha !== target.ref) {
                current = await readAt(target, file, what, sha)
                content = decide(current)
            }
        }
        const { sha: commit } = await target.client.commitFile(target.site, { path: file, content, message })
        return { current, commit }
    }

    server.registerTool('write_page', {
        title: 'Create or update a page',
        description: `Creates a page of a Nera site in a GitHub repository, or replaces an existing one, as one commit on the draft branch ${DRAFT_BRANCH} (created from main on the first change; nothing goes live until publish). \`frontmatter\` becomes the YAML block at the top of the file and must contain \`layout\` (the Pug layout under the theme's views folder that renders the page, e.g. \`pages/default.pug\` — read an existing page to see which layouts the site uses); \`title\` and \`description\` are usual too. Keys you leave out are removed; comments and quoting of unchanged keys are kept. \`body\` is the Markdown content; leave it out to keep the existing body. Afterwards call validate, then publish.`,
        inputSchema: {
            site: hostedSiteInput,
            path: pageInput,
            frontmatter: z.record(z.string(), z.unknown()).describe('The page\'s frontmatter as a JSON object; must contain `layout`.'),
            body: z.string().optional().describe('The page\'s Markdown content, without the frontmatter. Leave out to keep the existing body.'),
            message: messageInput,
        },
    }, hostedTool(async ({ site, path: page, frontmatter, body, message }) => {
        commitMessage(message)
        requireLayout(frontmatter)
        const file = repoPath(page, 'page path')
        refuseSecrets(file, file)
        const target = await openSite(site)
        const { folders, tree } = await siteModel(target)
        requirePagePath(file, folders)
        refuseBlockedPath(tree.entries, file)
        const { current, commit } = await commitToDraft(target, file, 'a page', (existing) => {
            if (existing?.content === null) {
                throw new ToolError(`The page "${file}" is ${existing.size} bytes, more than the ${MAX_READ_BYTES} bytes write_page edits.`)
            }
            return composePage(existing ? existing.content.toString('utf8') : null, frontmatter, body)
        }, message)
        const created = current === null
        return ok(
            { site: target.site, path: file, created, commit, branch: DRAFT_BRANCH },
            `${created ? 'Created' : 'Updated'} ${file} in ${target.site}. ${NEXT}`,
        )
    }))

    server.registerTool('write_file', {
        title: 'Create or update a site file',
        description: `Creates or replaces a text file of a Nera site in a GitHub repository, as one commit on the draft branch ${DRAFT_BRANCH} (created from main on the first change; nothing goes live until publish): configuration (\`config/app.yaml\`, \`config/<plugin>.yaml\`), Pug templates (\`theme/views/…\`), styles and scripts (\`assets/…\`). Pages (Markdown in the pages folder) go through write_page instead; the output folder (\`public/\`) is rebuilt on every build, so nothing is written there. Afterwards call validate, then publish.`,
        inputSchema: {
            site: hostedSiteInput,
            path: fileInput,
            content: z.string().describe('The complete new text of the file.'),
            message: messageInput,
        },
    }, hostedTool(async ({ site, path: input, content, message }) => {
        commitMessage(message)
        const file = repoPath(input, 'file path')
        refuseSecrets(file, file)
        refuseSegments(file, file, NO_WRITE_SEGMENTS, 'npm manages; add plugins to package.json instead')
        const target = await openSite(site)
        const { folders, tree } = await siteModel(target)
        const distFolder = repoFolder(folders.dist, 'dist')
        if (file === distFolder || file.startsWith(`${distFolder}/`)) {
            throw new ToolError(`"${file}" is in the output folder (${distFolder}/), which every build deletes and recreates. Change the page, template or asset it is built from instead.`)
        }
        const pagesFolder = repoFolder(folders.pages, 'pages')
        if (file.startsWith(`${pagesFolder}/`) && path.posix.extname(file) === '.md') {
            throw new ToolError(`"${file}" is a page. Use write_page, which checks the frontmatter.`)
        }
        refuseBlockedPath(tree.entries, file)
        const { current, commit } = await commitToDraft(target, file, 'a file', () => content, message)
        const created = current === null
        return ok(
            { site: target.site, path: file, created, commit, branch: DRAFT_BRANCH },
            `${created ? 'Created' : 'Updated'} ${file} in ${target.site}. ${NEXT}`,
        )
    }))

    server.registerTool('delete_page', {
        title: 'Delete a page',
        description: `Deletes one page (a Markdown file in the pages folder) of a Nera site in a GitHub repository, as one commit on the draft branch ${DRAFT_BRANCH} (nothing goes live until publish). Links to it from other pages or the navigation are not changed — check them with validate afterwards, then publish.`,
        inputSchema: { site: hostedSiteInput, path: pageInput, message: messageInput },
        annotations: { destructiveHint: true },
    }, hostedTool(async ({ site, path: page, message }) => {
        commitMessage(message)
        const file = repoPath(page, 'page path')
        refuseSecrets(file, file)
        const target = await openSite(site)
        const { folders } = await siteModel(target)
        requirePagePath(file, folders)
        const { commit } = await commitToDraft(target, file, 'a page', (existing) => {
            if (existing === null) {
                throw new ToolError(`The page "${file}" does not exist in ${target.site}. Call get_site for the list of pages.`)
            }
            return null
        }, message)
        return ok(
            { site: target.site, path: file, deleted: true, commit, branch: DRAFT_BRANCH },
            `Deleted ${file} in ${target.site}. ${NEXT}`,
        )
    }))
}
