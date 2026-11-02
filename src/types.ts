export interface Task {
  uuid: string;
  id?: number;
  description: string;
  status: string;
  project?: string;
  priority?: string;
  urgency?: number;
  tags?: string[];
  annotations?: { entry: string; description: string }[];
  [attribute: string]: unknown;
}

export interface Report {
  name: string;
  description: string;
  columns: string[];
  labels: string[];
  sort?: string;
  filter?: string;
}

export interface Meta {
  version: string;
  defaultReport: string;
  reports: Report[];
  projects: string[];
  tags: string[];
  contexts: string[];
  attributes: string[];
  priorities: string[];
  printEmptyColumns?: boolean;
}

export interface TaskResponse {
  tasks: Task[];
  report: Report;
  revision: string;
  context: string;
}
export interface CommandResponse {
  output: string;
  changed: boolean;
  report?: string;
  filter?: string;
}
