import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@project-x/ui';

export default function DashboardHomePage() {
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-semibold tracking-tight">Overview</h2>
        <p className="mt-1 text-sm text-slate-500">
          Placeholder dashboard shell. Product modules will be added in later sprints.
        </p>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Status</CardTitle>
            <CardDescription>Foundation is online.</CardDescription>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-slate-600">
              API, Redis, and Postgres wiring land with Day 1 infra.
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Next</CardTitle>
            <CardDescription>No business features yet.</CardDescription>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-slate-600">
              Auth, tenancy, and domain modules start on Day 2+.
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
