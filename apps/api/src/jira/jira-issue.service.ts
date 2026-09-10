import { Injectable, Logger } from '@nestjs/common';
import type { JiraIssue } from '@project-x/types';
import {
  JIRA_MAX_COMMENTS,
  JIRA_MAX_DESCRIPTION_CHARS,
  JIRA_MAX_TOTAL_CONTEXT_CHARS,
} from '@project-x/types';

import { boundComments, normalizeJiraRichText } from './jira-adf';
import { JiraConnectionService } from './jira-connection.service';
import { JiraErrorNormalizer } from './jira-error-normalizer';
import { jiraSiteBaseUrl, normalizeJiraIssueKey, normalizeJiraSiteHost } from './jira-site';

type JiraIssueApiResponse = {
  id?: string;
  key?: string;
  fields?: {
    summary?: string;
    description?: unknown;
    issuetype?: { name?: string };
    status?: { id?: string; name?: string; statusCategory?: { name?: string } };
    priority?: { name?: string };
    project?: { id?: string; key?: string; name?: string };
    assignee?: { accountId?: string; displayName?: string };
    reporter?: { accountId?: string; displayName?: string };
    labels?: string[];
    components?: Array<{ name?: string }>;
    fixVersions?: Array<{ name?: string }>;
    created?: string;
    updated?: string;
    comment?: {
      comments?: Array<{
        id?: string;
        created?: string;
        author?: { displayName?: string };
        body?: unknown;
      }>;
    };
    attachment?: Array<{ filename?: string }>;
    issuelinks?: Array<{
      type?: { name?: string; inward?: string; outward?: string };
      inwardIssue?: { key?: string; fields?: { summary?: string } };
      outwardIssue?: { key?: string; fields?: { summary?: string } };
    }>;
  };
  errorMessages?: string[];
  message?: string;
};

@Injectable()
export class JiraIssueService {
  private readonly logger = new Logger(JiraIssueService.name);

  constructor(
    private readonly connections: JiraConnectionService,
    private readonly errors: JiraErrorNormalizer,
  ) {}

  async getIssue(userId: string, issueKeyRaw: string, pageHostRaw?: string): Promise<JiraIssue> {
    const issueKey = normalizeJiraIssueKey(issueKeyRaw);
    if (!issueKey) {
      throw this.errors.toHttpException(
        'JIRA_ISSUE_NOT_FOUND',
        'Issue key must look like PROJECT-123.',
      );
    }

    const credentials = await this.connections.getDecryptedCredentials(userId);
    if (!credentials) {
      throw this.errors.toHttpException(
        'JIRA_NOT_CONNECTED',
        'Connect Jira to use issue intelligence.',
      );
    }

    if (pageHostRaw?.trim()) {
      const pageHost = normalizeJiraSiteHost(pageHostRaw);
      if (!pageHost) {
        throw this.errors.toHttpException(
          'JIRA_SITE_NOT_ACCESSIBLE',
          'This Jira host is not a supported Atlassian Cloud site.',
        );
      }
      if (pageHost !== credentials.siteHost) {
        throw this.errors.toHttpException(
          'JIRA_SITE_NOT_CONNECTED',
          'This Jira site is not connected to Project X.',
        );
      }
    }

    const url = `${jiraSiteBaseUrl(credentials.siteHost)}/rest/api/3/issue/${encodeURIComponent(issueKey)}?fields=summary,description,issuetype,status,priority,project,assignee,reporter,labels,components,fixVersions,created,updated,comment,attachment,issuelinks&expand=renderedFields`;

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          Authorization: `Basic ${Buffer.from(`${credentials.email}:${credentials.apiToken}`, 'utf8').toString('base64')}`,
          'User-Agent': 'Project-X',
        },
      });
    } catch {
      throw this.errors.toHttpException(
        'JIRA_UNAVAILABLE',
        'Unable to reach Jira to load this issue.',
      );
    }

    const payload = (await response.json().catch(() => ({}))) as JiraIssueApiResponse;
    if (!response.ok) {
      const msg = payload.errorMessages?.[0] ?? payload.message;
      if (response.status === 404) {
        throw this.errors.toHttpException(
          'JIRA_ISSUE_NOT_FOUND',
          'Jira could not find that issue (or the account cannot access it).',
        );
      }
      if (response.status === 403) {
        throw this.errors.toHttpException(
          'JIRA_ISSUE_NOT_ACCESSIBLE',
          'Your connected Jira account cannot access this issue.',
        );
      }
      throw this.errors.fromJiraStatus(response.status, msg);
    }

    return this.normalizeIssue(payload, credentials.siteHost);
  }

  private normalizeIssue(payload: JiraIssueApiResponse, siteHost: string): JiraIssue {
    const fields = payload.fields ?? {};
    const key = (payload.key ?? '').toUpperCase();
    const projectKey = fields.project?.key?.toUpperCase() ?? key.split('-')[0] ?? 'UNKNOWN';
    const description = normalizeJiraRichText(fields.description, JIRA_MAX_DESCRIPTION_CHARS);

    const rawComments = (fields.comment?.comments ?? [])
      .slice(-JIRA_MAX_COMMENTS)
      .map((c) => ({
        id: String(c.id ?? ''),
        author: c.author?.displayName,
        createdAt: c.created,
        body: normalizeJiraRichText(c.body, 4_000),
      }))
      .filter((c) => c.id);

    const bounded = boundComments(rawComments);
    const attachments = fields.attachment ?? [];
    const links =
      fields.issuelinks?.flatMap((link) => {
        const items: JiraIssue['links'] = [];
        if (link.inwardIssue?.key) {
          items?.push({
            type: link.type?.inward ?? link.type?.name,
            direction: 'inward',
            issueKey: link.inwardIssue.key,
            issueSummary: link.inwardIssue.fields?.summary,
          });
        }
        if (link.outwardIssue?.key) {
          items?.push({
            type: link.type?.outward ?? link.type?.name,
            direction: 'outward',
            issueKey: link.outwardIssue.key,
            issueSummary: link.outwardIssue.fields?.summary,
          });
        }
        return items ?? [];
      }) ?? [];

    let truncated = description.truncated || bounded.truncated;
    let comments = bounded.comments.map((c) => ({
      id: c.id,
      authorDisplayName: c.author,
      createdAt: c.createdAt,
      body: c.body,
    }));

    // Cap total context size
    let total =
      description.plainText.length + comments.reduce((sum, c) => sum + c.body.plainText.length, 0);
    while (total > JIRA_MAX_TOTAL_CONTEXT_CHARS && comments.length > 0) {
      comments = comments.slice(1);
      truncated = true;
      total =
        description.plainText.length +
        comments.reduce((sum, c) => sum + c.body.plainText.length, 0);
    }

    this.logger.log({
      msg: 'jira.issue.fetch',
      siteHost,
      issueKey: key,
      commentCount: comments.length,
      truncated,
      attachmentCount: attachments.length,
    });

    return {
      id: String(payload.id ?? key),
      key,
      project: {
        id: fields.project?.id,
        key: projectKey,
        name: fields.project?.name,
      },
      issueType: fields.issuetype?.name,
      summary: (fields.summary ?? key).trim(),
      description: description.plainText
        ? { plainText: description.plainText, truncated: description.truncated }
        : undefined,
      status: fields.status?.name
        ? {
            id: fields.status.id,
            name: fields.status.name,
            category: fields.status.statusCategory?.name,
          }
        : undefined,
      priority: fields.priority?.name,
      assignee: fields.assignee
        ? {
            accountId: fields.assignee.accountId,
            displayName: fields.assignee.displayName,
          }
        : undefined,
      reporter: fields.reporter
        ? {
            accountId: fields.reporter.accountId,
            displayName: fields.reporter.displayName,
          }
        : undefined,
      labels: fields.labels,
      components: fields.components?.map((c) => c.name).filter((n): n is string => Boolean(n)),
      fixVersions: fields.fixVersions?.map((v) => v.name).filter((n): n is string => Boolean(n)),
      createdAt: fields.created,
      updatedAt: fields.updated,
      links,
      comments,
      attachmentCount: attachments.length,
      attachmentNames: attachments
        .map((a) => a.filename)
        .filter((n): n is string => Boolean(n))
        .slice(0, 10),
      url: `${jiraSiteBaseUrl(siteHost)}/browse/${key}`,
      siteHost,
      truncated: truncated || undefined,
      fetchedAt: new Date().toISOString(),
    };
  }
}
