import * as core from '@actions/core'
import * as github from '@actions/github'
import { GitHub } from '@actions/github/lib/utils'
import * as yaml from 'js-yaml'

type ModeEvent =
  | 'pull_request'
  | 'pull_request_target'
  | 'issues'
  | 'issue_comment'
  | 'push'

interface ILabelMode {
  // if matched && (~ === true || the triggered event in ~) => add
  add: ModeEvent[] | true

  // if not matched && (~ === true || the triggered event in ~) => remove
  remove: ModeEvent[] | true
}

interface ICommentMode {
  // add: add comment, update: update issue or comment
  type: 'add' | 'update'

  // if matched && (~ === true || the triggered event in ~) => add or update
  event: ModeEvent[] | true
}

interface IRuleBase {
  [key: string]: unknown

  // the representation of the rule
  name: string

  // the content of the rule
  //     for labels, it's the label name
  //     for comments, it's the comment body
  // if not provided (=== undefined), use `name` as the content
  // if === '', not add label
  content?: string

  // the regexes to match the issue/comment body
  regexes: string[]

  // the author association to match
  author_association: string[]

  // if some item in skip_if has been added, skip current item
  skip_if: string[]
}

interface ILabelRule extends IRuleBase {
  mode: ILabelMode

  // if some item in remove_if has been added, remove current item, higher priority than mode.remove
  remove_if: string[]
}

interface ICommentRule extends IRuleBase {
  mode: ICommentMode
}

interface IEventInfo {
  event_name: string
  issue_number: number | number[] // number[] for push event
  comment_id?: number
  title: string
  body: string
  created_at: string
  author_association: string
}

interface ICondPred {
  cond: (x: unknown) => boolean
  pred: (x: unknown) => unknown
}

async function run(): Promise<void> {
  try {
    // Configuration parameters
    const configPath: string = core.getInput('configuration-path', {
      required: true
    })
    const token: string = core.getInput('repo-token', { required: true })
    const notBefore: number = Date.parse(
      core.getInput('not-before', { required: false })
    )
    const includeTitle: number = parseInt(
      core.getInput('include-title', { required: false })
    )
    const syncLabels: number = parseInt(
      core.getInput('sync-labels', { required: false })
    )

    const {
      event_name: _event_name,
      issue_number: issue_number,
      comment_id: comment_id,
      title: title,
      body: body,
      created_at: created_at,
      author_association: author_association
    } = getEventInfo()

    const event_name = getModeEvent(_event_name)
    if (event_name === undefined) {
      throw Error(`could not handle event \`${_event_name}\``)
    }

    if (core.isDebug()) {
      core.debug(`event_name: ${event_name}`)
      core.debug(`issue_number: ${issue_number}`)
      core.debug(`title: ${title}`)
      core.debug(`body: ${body}`)
      core.debug(`created_at: ${created_at}`)
      core.debug(`author_association: ${author_association}`)
    }

    // A client to load data from GitHub
    const client = github.getOctokit(token)

    if (event_name === 'push' /* || event_name === 'commit_comment'*/) {
      if (issue_number && Array.isArray(issue_number)) {
        for (const issue of issue_number) {
          core.notice(`This push fixed issue #${issue}.`)
          addLabels(client, issue, ['fixed'])
        }
      }
    } else {
      if (Array.isArray(issue_number)) {
        throw Error(`unknown error`)
      }
      // If the notBefore parameter has been set to a valid timestamp,
      // exit if the current issue was created before notBefore
      if (notBefore) {
        const createdAt: number = Date.parse(created_at)
        core.info(`Issue is created at ${created_at}.`)
        if (Number.isNaN(createdAt)) {
          throw Error(`cannot deduce \`createdAt\` from ${created_at}`)
        } else if (createdAt < notBefore) {
          core.notice(
            'Issue is before `notBefore` configuration parameter. Exiting...'
          )
          return
        }
      } else {
        core.debug(`Parameter \`notBefore\` is not set or is set invalid.`)
      }

      const [labelParams, commentParams] = await loadRules(
        client,
        configPath,
        syncLabels
      )
      const issueLabels = await getCurrentLabels(client, issue_number)

      // labels to be added & removed
      const LabelAnalyzeResult = labelRuleAnalyze(
        labelParams,
        (includeTitle === 1 ? `${title}\n\n` : '') + body,
        author_association,
        event_name
      )
      let addLabelItems = LabelAnalyzeResult[0]
      const removeLabelItems = LabelAnalyzeResult[1]

      // comments to be added & updated
      const [addCommentItems, updateCommentItems] = commentRuleAnalyze(
        commentParams,
        body,
        author_association,
        event_name
      )

      if (core.isDebug()) {
        core.debug(`labels have been added: [${Array.from(issueLabels)}]`)
        core.debug(`labels to be added: [${addLabelItems.toString()}]`)
        core.debug(`labels to be removed: [${removeLabelItems.toString()}]`)
      }

      // some may have been added, remove them
      addLabelItems = addLabelItems.filter(label => !issueLabels.has(label))
      if (addLabelItems.length > 0) {
        core.info(
          `Adding labels ${addLabelItems.toString()} to issue #${issue_number}`
        )
        addLabels(client, issue_number, addLabelItems)
      }

      if (syncLabels) {
        for (const label of removeLabelItems) {
          // skip labels that have not been added
          if (issueLabels.has(label)) {
            core.info(`Removing label ${label} from issue #${issue_number}`)
            removeLabel(client, issue_number, label)
          }
        }
      }

      for (const itemBody of addCommentItems) {
        core.info(`Comment ${itemBody} to issue #${issue_number}`)
        addComment(client, issue_number, itemBody)
      }

      if (event_name === 'issue_comment') {
        if (!comment_id || isNaN(comment_id)) {
          throw Error(`event name is ${event_name}, but comment_id is missing`)
        }
        for (const updateCommentItem of updateCommentItems) {
          core.info(`Update comment ${comment_id} to issue #${issue_number}`)
          updateComment(client, comment_id, updateCommentItem)
        }
      } else {
        for (const updateCommentItem of updateCommentItems) {
          core.info(`Update issue #${issue_number}`)
          updateIssue(client, issue_number, updateCommentItem)
        }
      }
    }
  } catch (error) {
    if (error instanceof Error) {
      core.error(error)
      core.setFailed(error.message)
    }
  }
}

function commentRuleAnalyze(
  itemMap: ICommentRule[],
  issueContent: string,
  author_association: string,
  event_name: ModeEvent
): [string[], string[]] {
  const addItems: string[] = []
  const addItemNames: Set<string> = new Set()
  const updateItems: string[] = []

  for (const itemParams of itemMap) {
    const item = itemParams.content ?? ''
    const itemName = itemParams.name
    const globs = itemParams.regexes
    const allowedAuthorAssociation = itemParams.author_association
    const mode = itemParams.mode
    const skipIf = itemParams.skip_if
    const modeType = mode.type
    const needComment = mode.event === true || mode.event.includes(event_name)

    if (skipIf.filter(x => addItemNames.has(x)).length > 0) {
      // 此项的 skip-if 中包含待添加的项，直接跳过
      if (core.isDebug()) {
        core.debug(
          `Skip item, because skip_if \`${skipIf}\` contains some item in added items \`${Array.from(addItemNames)}\``
        )
      }
      continue
    }

    if (!needComment) {
      continue
    }

    if (checkAuthorAssociation(author_association, allowedAuthorAssociation)) {
      const matches = checkRegexes(issueContent, globs)
      if (matches === false) {
        continue
      }
      // TODO item: "...${i,j}..." -> "...${matches[i][j]}..."

      // item: "...${body}..." -> "...${issueContent}..."
      const itemBody = item.replace(/\$\{body\}/g, issueContent)

      if (modeType === 'add') {
        addItemNames.add(itemName)
        if (item !== '') addItems.push(itemBody)
      } else if (modeType === 'update') {
        if (item !== '') updateItems.push(itemBody)
      }
    }
  }

  return [addItems, updateItems]
}

function labelRuleAnalyze(
  itemMap: ILabelRule[],
  issueContent: string,
  author_association: string,
  event_name: ModeEvent
): [string[], string[]] {
  const addItems: string[] = []
  const addItemNames: Set<string> = new Set()
  const removeItems: string[] = []

  for (const itemParams of itemMap) {
    const item = itemParams.content ?? ''
    const itemName = itemParams.name
    const globs = itemParams.regexes
    const allowedAuthorAssociation = itemParams.author_association
    const mode = itemParams.mode
    const skipIf = itemParams.skip_if
    const removeIf = itemParams.remove_if
    const needAdd =
      mode.add !== undefined &&
      (mode.add === true || mode.add.includes(event_name))
    const needRemove =
      mode.remove !== undefined &&
      (mode.remove === true || mode.remove.includes(event_name))

    core.debug(
      `item \`${itemName}\` (needAdd = ${needAdd}, needRemove = ${needRemove}, mode = ${JSON.stringify(mode)})`
    )

    if (skipIf.filter(x => addItemNames.has(x)).length > 0) {
      // 此项的 skip-if 中包含待添加的项，直接跳过
      if (core.isDebug()) {
        core.debug(
          `Skip item, because skip_if \`${skipIf}\` contains some item in added items \`${Array.from(addItemNames)}\``
        )
      }
      continue
    }

    if (removeIf.filter(x => addItemNames.has(x)).length > 0) {
      // 此项的 remove-if 中包含待添加的项，直接删除，优先级高于 needRemove
      if (item !== '' && !removeItems.includes(item)) {
        if (core.isDebug()) {
          core.debug(
            `Remove item, because remove_if \`${removeIf}\` contains some item in added items \`${Array.from(addItemNames)}\``
          )
        }
        removeItems.push(item)
      }
      continue
    }

    if (
      checkAuthorAssociation(author_association, allowedAuthorAssociation) &&
      checkRegexes(issueContent, globs) !== false
    ) {
      if (needAdd) {
        if (item !== '' && !addItems.includes(item)) {
          addItems.push(item)
        }
        addItemNames.add(itemName)
      }
    } else if (needRemove && item !== '' && !removeItems.includes(item)) {
      removeItems.push(item)
    }
  }

  // 返回需要添加的项和需要删除的项，删除优先级高于添加
  return [addItems.filter(item => !removeItems.includes(item)), removeItems]
}

function getEventInfo(): IEventInfo {
  const getEventDetails = (issue: {
    [key: string]: unknown
    number?: number
    title?: string
    body?: string
    created_at?: string
    author_association?: string
  }): IEventInfo => {
    return {
      event_name: github.context.eventName,
      issue_number: issue.number ?? NaN,
      title: issue.title ?? '',
      body: issue.body ?? '',
      created_at: issue.created_at ?? '',
      author_association: issue.author_association ?? ''
    }
  }
  const payload = github.context.payload
  const event_name = github.context.eventName
  if (event_name === 'issues') {
    return getEventDetails(payload.issue ?? {})
  }

  if (event_name === 'pull_request_target' || event_name === 'pull_request') {
    return getEventDetails(payload.pull_request ?? {})
  }

  if (event_name === 'issue_comment') {
    const eventInfo = getEventDetails(payload.comment ?? {})
    eventInfo.comment_id = payload.comment?.id ?? NaN
    eventInfo.issue_number = payload.issue?.number ?? NaN
    eventInfo.title = payload.issue?.title ?? ''
    return eventInfo
  }

  if (event_name === 'push') {
    let messages = ''
    for (const commit of payload.commits) messages += `${commit.message}\n\n`
    const issue_numbers: number[] = []
    const globs = /(?:[Ff]ix|[Cc]lose)\s+(?:#|.*\/issues\/)(\d+)/
    let matchResult = messages.match(globs)
    while (matchResult && matchResult.index) {
      issue_numbers.push(parseInt(matchResult[1]))
      messages = messages.slice(matchResult.index + matchResult[0].length)
      matchResult = messages.match(globs)
    }
    return {
      event_name: event_name,
      issue_number: issue_numbers,
      title: '',
      body: messages,
      created_at: '1970-01-01T00:00:00Z', // TODO
      author_association: '' // TODO
    }
  }

  throw Error(`could not handle event \`${event_name}\``)
}

async function loadRules(
  client: InstanceType<typeof GitHub>,
  configurationPath: string,
  syncLabels: number
): Promise<[ILabelRule[], ICommentRule[]]> {
  const response = await client.rest.repos.getContent({
    owner: github.context.repo.owner,
    repo: github.context.repo.repo,
    path: configurationPath,
    ref: github.context.sha
  })

  const data = response.data as { content?: string }
  if (!data.content) {
    throw Error(`the configuration path provides an invalid file`)
  }

  const configObject = yaml.load(
    Buffer.from(data.content, 'base64').toString('utf8')
  )

  // transform `any` => `item_t[]` or throw if yaml is malformed:
  return parseAllRules(configObject, syncLabels)
}

function appendLabelMode(
  mode: ILabelMode,
  modeKey: string,
  modeItems: unknown[] | true = true
): void {
  if (modeKey === 'add' || modeKey === 'remove') {
    if (mode[modeKey] === true) {
    } else if (modeItems === true) {
      mode[modeKey] = true
    } else {
      mode[modeKey] ??= []
      for (const modeItem of modeItems) {
        const modeItemValue = getModeEvent(modeItem)
        if (!modeItemValue) {
          throw Error(`found unexpected value \`${modeItem}\``)
        }
        mode[modeKey].push(modeItemValue)
      }
    }
    return
  }

  const modeItemValue = getModeEvent(modeKey)
  if (modeItemValue) {
    if (modeItems === true) {
      modeItems = ['add', 'remove']
    }
    for (const modeItem of modeItems) {
      if (modeItem === 'add') {
        mode.add ??= []
        if (mode.add !== true) mode.add.push(modeItemValue)
      } else if (modeItem === 'remove') {
        mode.remove ??= []
        if (mode.remove !== true) mode.remove.push(modeItemValue)
      } else {
        throw Error(`found unexpected value \`${modeItem}\``)
      }
    }
  } else {
    throw Error(`found unexpected value \`${modeKey}\``)
  }
}

function parseLabelMode(modeItem: unknown): ILabelMode {
  const modeMap: ILabelMode = { add: [], remove: [] }
  if (typeof modeItem === 'string') {
    appendLabelMode(modeMap, modeItem)
  } else if (Array.isArray(modeItem)) {
    for (const value of modeItem) {
      if (typeof value !== 'string') {
        throw Error(
          `parseLabelMode found unexpected type of configuration object`
        )
      }
      appendLabelMode(modeMap, value)
    }
  } else if (modeItem !== null && typeof modeItem === 'object') {
    for (const key in modeItem) {
      const value = (modeItem as { [key: string]: unknown })[key]
      if (value === null) {
        appendLabelMode(modeMap, key, true)
      } else if (typeof value === 'string') {
        appendLabelMode(modeMap, key, [value])
      } else if (Array.isArray(value)) {
        appendLabelMode(modeMap, key, value)
      } else {
        throw Error(
          `parseLabelMode found unexpected type of configuration object`
        )
      }
    }
  }
  return modeMap
}

function parseCommentMode(modeItem: unknown): ICommentMode {
  const commentMode: ICommentMode = { type: 'add', event: true }
  if (typeof modeItem === 'string') {
    if (modeItem !== 'add' && modeItem !== 'update') {
      throw Error(
        `parseCommentMode found unexpected value \`${modeItem}\` of field \`type\``
      )
    }
    commentMode.type = modeItem
    return commentMode
  }
  if (modeItem === null || typeof modeItem !== 'object') {
    throw Error(
      `parseCommentMode found unexpected type of configuration object`
    )
  }
  for (const key in modeItem) {
    if (key !== 'type' && key !== 'event') {
      throw Error(`parseCommentMode found unexpected field \`${key}\``)
    }
  }
  if ('type' in modeItem) {
    if (modeItem.type !== 'add' && modeItem.type !== 'update') {
      throw Error(
        `parseCommentMode found unexpected value \`${modeItem.type}\` of field \`type\``
      )
    }
    commentMode.type = modeItem.type
  }
  if ('event' in modeItem) {
    if (Array.isArray(modeItem.event)) {
      commentMode.event = []
      for (const modeEvent of modeItem.event) {
        const modeEventValue = getModeEvent(modeEvent)
        if (!modeEventValue) {
          throw Error(
            `parseCommentMode found unexpected value \`${modeEvent}\` of field \`event\``
          )
        }
        commentMode.event.push(modeEventValue)
      }
    }
    const modeEvent = getModeEvent(modeItem.event)
    if (modeEvent === undefined) {
      throw Error(
        `parseCommentMode found unexpected value \`${modeItem.event}\` of field \`event\``
      )
    }
    commentMode.event = [modeEvent]
  }
  return commentMode
}

function parseLabelRule(item: unknown, default_mode: ILabelMode): ILabelRule {
  const is_str = (x: unknown): boolean => typeof x === 'string'
  const is_strarr = (x: unknown): boolean => Array.isArray(x)
  const nopred = (x: unknown): unknown => x
  const pred_2arr = (x: unknown): unknown[] => [x]
  const str2strarr: ICondPred = {
    cond: is_str,
    pred: pred_2arr
  }
  const strarr2strarr: ICondPred = {
    cond: is_strarr,
    pred: nopred
  }
  const mode_cond_pred: ICondPred = {
    cond: (): boolean => true,
    pred: parseLabelMode
  }
  return parseRule(
    item,
    {
      remove_if: [str2strarr, strarr2strarr],
      mode: [mode_cond_pred]
    },
    {
      remove_if: [],
      mode: default_mode
    }
  ) as ILabelRule
}

function parseCommentRule(
  item: unknown,
  default_mode: ICommentMode
): ICommentRule {
  const mode_cond_pred: ICondPred = {
    cond: (): boolean => true,
    pred: parseCommentMode
  }
  return parseRule(
    item,
    { mode: [mode_cond_pred] },
    { mode: default_mode }
  ) as ICommentRule
}

function parseRule(
  item: unknown,
  appendConfigMap: { [key: string]: ICondPred[] },
  appendItemParams: { [key: string]: unknown }
): IRuleBase {
  if (item === null || typeof item !== 'object') {
    throw Error(`parseRule found unexpected type of configuration object`)
  }

  const is_str = (x: unknown): boolean => typeof x === 'string'
  const is_strarr = (x: unknown): boolean => Array.isArray(x)
  const is_null = (x: unknown): boolean => x === null
  const nopred = (x: unknown): unknown => x
  const pred_2arr = (x: unknown): unknown[] => [x]
  const pred_2emptystr = (): string => ''

  const str2str: ICondPred = {
    cond: is_str,
    pred: nopred
  }
  const str2strarr: ICondPred = {
    cond: is_str,
    pred: pred_2arr
  }
  const strarr2strarr: ICondPred = {
    cond: is_strarr,
    pred: nopred
  }
  const null2str: ICondPred = {
    cond: is_null,
    pred: pred_2emptystr
  }

  const configMap: { [key: string]: ICondPred[] } = {
    ...appendConfigMap,
    name: [str2str],
    content: [str2str, null2str],
    author_association: [str2strarr, strarr2strarr],
    regexes: [str2strarr, strarr2strarr],
    skip_if: [str2strarr, strarr2strarr]
  }
  const itemParams: IRuleBase = {
    ...appendItemParams,
    name: '',
    content: undefined,
    author_association: [],
    regexes: [],
    skip_if: []
  }
  for (const key in item) {
    // skip-if -> skip_if, ...
    const replaced_key = key.replace('-', '_')
    if (replaced_key in configMap) {
      const value = (item as { [key: string]: unknown })[key]
      const cond_preds = configMap[replaced_key]
      for (const cond_pred of cond_preds) {
        if (cond_pred.cond(value)) {
          itemParams[replaced_key] = cond_pred.pred(value)
          break
        }
      }
    } else {
      throw Error(`found unexpected field \`${key}\``)
    }
  }
  if (!itemParams.name) {
    throw Error(`some item's name is missing`)
  }
  itemParams.content ??= itemParams.name
  return itemParams
}

function getModeEvent(modeItem: unknown): ModeEvent | undefined {
  return modeItem === 'pull_request' ||
    modeItem === 'pull_request_target' ||
    modeItem === 'issues' ||
    modeItem === 'issue_comment' ||
    modeItem === 'push'
    ? modeItem
    : undefined
}

function parseLabelRules(
  configObject: unknown,
  default_mode: ILabelMode
): ILabelRule[] {
  const itemArray: ILabelRule[] = []
  if (!Array.isArray(configObject)) {
    throw Error(`configObject found unexpected type of configuration object`)
  }
  for (const item of configObject) {
    const itemParams: ILabelRule = parseLabelRule(item, default_mode)
    itemArray.push(itemParams)
  }
  return itemArray
}

function parseCommentRules(
  configObject: unknown,
  default_mode: ICommentMode
): ICommentRule[] {
  const itemArray: ICommentRule[] = []
  if (!Array.isArray(configObject)) {
    throw Error(
      `parseCommentRules found unexpected type of configuration object`
    )
  }
  for (const item of configObject) {
    const itemParams: ICommentRule = parseCommentRule(item, default_mode)
    itemArray.push(itemParams)
  }
  return itemArray
}

function parseAllRules(
  configObject: unknown,
  syncLabels: number
): [ILabelRule[], ICommentRule[]] {
  if (configObject === null || typeof configObject !== 'object') {
    throw Error(`parseAllRules found unexpected type of configuration object`)
  }

  for (const key in configObject) {
    if (key !== 'labels' && key !== 'comments' && key !== 'default-mode') {
      throw Error(`parseAllRules found unexpected field \`${key}\``)
    }
  }

  const labelParamsObject = 'labels' in configObject ? configObject.labels : []
  const commentParamsObject =
    'comments' in configObject ? configObject.comments : []
  let labelDefaultMode: ILabelMode | undefined =
    'default-mode' in configObject
      ? parseLabelMode(configObject['default-mode'])
      : undefined

  if (labelDefaultMode === undefined) {
    if (syncLabels === 1) {
      labelDefaultMode = {
        add: true,
        remove: true
      }
    } else if (syncLabels === 0) {
      labelDefaultMode = { add: true, remove: [] }
    } else {
      throw Error(
        `parseAllRules found unexpected value of syncLabels (${syncLabels}, should be 0 or 1)`
      )
    }
  }
  return [
    parseLabelRules(labelParamsObject, labelDefaultMode),
    parseCommentRules(commentParamsObject, { type: 'add', event: true })
  ]
}

function checkRegexes(
  body: string,
  regexes: string[]
): RegExpMatchArray[] | false {
  const matches: RegExpMatchArray[] = []

  // If several regex entries are provided we require all of them to match for the label to be applied.
  for (const regEx of regexes) {
    const isRegEx = regEx.match(/^\/(.+)\/(.*)$/)
    const matched = isRegEx
      ? body.match(new RegExp(isRegEx[1], isRegEx[2]))
      : body.match(regEx)

    if (!matched) {
      return false
    }
    matches.push(matched)
  }
  return matches
}

function checkAuthorAssociation(
  author_association: string,
  regexes: string[]
): boolean {
  let matched

  // If several regex entries are provided we require all of them to match for the label to be applied.
  for (const regEx of regexes) {
    const isRegEx = regEx.match(/^\/(.+)\/(.*)$/)

    if (isRegEx) {
      matched = author_association.match(new RegExp(isRegEx[1], isRegEx[2]))
    } else {
      matched = author_association.match(regEx)
    }

    if (!matched) {
      return false
    }
  }
  return true
}

async function getCurrentLabels(
  client: InstanceType<typeof GitHub>,
  issue_number: number
): Promise<Set<string>> {
  const labels: Set<string> = new Set()
  try {
    const response = await client.rest.issues.listLabelsOnIssue({
      owner: github.context.repo.owner,
      repo: github.context.repo.repo,
      issue_number
    })
    core.debug(`Load labels status ${response.status}`)
    const data = response.data
    for (let i = 0; i < Object.keys(data).length; i++) {
      labels.add(data[i].name)
    }
    return labels
  } catch (error) {
    core.warning(`Unable to load labels. (${error})`)
    return labels
  }
}

async function addLabels(
  client: InstanceType<typeof GitHub>,
  issue_number: number,
  labels: string[]
): Promise<void> {
  try {
    const response = await client.rest.issues.addLabels({
      owner: github.context.repo.owner,
      repo: github.context.repo.repo,
      issue_number,
      labels
    })
    core.debug(`Add labels status ${response.status}`)
  } catch (error) {
    core.warning(`Unable to add labels. (${error})`)
  }
}

async function removeLabel(
  client: InstanceType<typeof GitHub>,
  issue_number: number,
  name: string
): Promise<void> {
  try {
    const response = await client.rest.issues.removeLabel({
      owner: github.context.repo.owner,
      repo: github.context.repo.repo,
      issue_number,
      name
    })
    core.debug(`Remove label \`${name}\` status ${response.status}`)
  } catch (error) {
    core.warning(`Unable to remove label ${name}. (${error})`)
  }
}

async function addComment(
  client: InstanceType<typeof GitHub>,
  issue_number: number,
  body: string
): Promise<void> {
  try {
    const response = await client.rest.issues.createComment({
      owner: github.context.repo.owner,
      repo: github.context.repo.repo,
      issue_number,
      body
    })
    core.debug(
      `Add comment \`${body.split('\n').join('\\n')}\` status ${
        response.status
      }`
    )
  } catch (error) {
    core.warning(
      `Unable to add comment \`${body.split('\n').join('\\n')}\`. (${error})`
    )
  }
}

async function updateComment(
  client: InstanceType<typeof GitHub>,
  issue_number: number,
  body: string
): Promise<void> {
  try {
    const response = await client.rest.issues.updateComment({
      owner: github.context.repo.owner,
      repo: github.context.repo.repo,
      comment_id: issue_number,
      body
    })
    core.debug(
      `Update comment \`${body.split('\n').join('\\n')}\` status ${
        response.status
      }`
    )
  } catch (error) {
    core.warning(
      `Unable to update comment \`${body.split('\n').join('\\n')}\`. (${error})`
    )
  }
}

async function updateIssue(
  client: InstanceType<typeof GitHub>,
  issue_number: number,
  body: string
): Promise<void> {
  try {
    const response = await client.rest.issues.update({
      owner: github.context.repo.owner,
      repo: github.context.repo.repo,
      issue_number,
      body
    })
    core.debug(
      `Update issue \`${body.split('\n').join('\\n')}\` status ${
        response.status
      }`
    )
  } catch (error) {
    core.warning(
      `Unable to update issue \`${body.split('\n').join('\\n')}\`. (${error})`
    )
  }
}

run()
