/**
 * Sign in and sign up.
 *
 * Both forms do the same four things — validate locally, submit, show a pending state, show
 * the server's own error — so they share a layout and an error renderer rather than each
 * inventing its own.
 *
 * The error renderer is worth a note. The server answers a failed signup with
 * `VALIDATION_ERROR` and a zod issue list in `details`, and a failed login with
 * `INVALID_CREDENTIALS` and no details. Rendering only `message` would turn "password must
 * be at least 12 characters" into "Request failed validation" — technically true, useless
 * to the person typing. So field-level issues are lifted onto their fields, and anything
 * else is shown once, at the top.
 */

import { useState, type FormEvent, type ReactNode } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { PASSWORD_MIN_LENGTH } from '@nexs/shared';
import { ApiClientError } from '../../lib/api';
import { useAuth } from './auth-context';
import { Button, Field } from '../../components/ui';

/** One zod issue, as the server sends it in `error.details`. */
interface ValidationIssue {
  path: (string | number)[];
  message: string;
}

function issuesFrom(error: unknown): Record<string, string> {
  if (!(error instanceof ApiClientError)) return {};
  if (error.code !== 'VALIDATION_ERROR' || !Array.isArray(error.details)) return {};

  const fields: Record<string, string> = {};
  for (const raw of error.details as unknown[]) {
    if (typeof raw !== 'object' || raw === null) continue;
    const issue = raw as ValidationIssue;
    const key = issue.path?.[0];
    if (typeof key === 'string' && typeof issue.message === 'string') {
      fields[key] = issue.message;
    }
  }
  return fields;
}

function AuthShell({
  title,
  subtitle,
  children,
  footer,
}: {
  title: string;
  subtitle: string;
  children: ReactNode;
  footer: ReactNode;
}): ReactNode {
  return (
    <div
      style={{
        minHeight: '100%',
        display: 'grid',
        placeItems: 'center',
        padding: 24,
      }}
    >
      <div style={{ width: '100%', maxWidth: 380 }} className="stack">
        <div className="row" style={{ gap: 8 }}>
          <span className="brand-mark">N</span>
          <strong>NEXS</strong>
          <span className="muted small">Agent Control Plane</span>
        </div>

        <div className="card">
          <div className="card-body stack">
            <div className="stack-sm">
              <h1>{title}</h1>
              <p className="muted small">{subtitle}</p>
            </div>
            {children}
          </div>
        </div>

        <div className="center small muted">{footer}</div>
      </div>
    </div>
  );
}

/** The server's error, minus the parts already shown against a field. */
function FormError({ error, fieldErrors }: { error: unknown; fieldErrors: Record<string, string> }): ReactNode {
  if (error === null || error === undefined) return null;

  const { code, message } =
    error instanceof ApiClientError
      ? { code: error.code, message: error.message }
      : { code: 'ERROR', message: error instanceof Error ? error.message : String(error) };

  // When every issue landed on a field, a summary line adds nothing but noise.
  const hasFieldErrors = Object.keys(fieldErrors).length > 0;
  if (code === 'VALIDATION_ERROR' && hasFieldErrors) return null;

  return (
    <div className="error-box" role="alert">
      <div className="error-code">{code}</div>
      <div>{message}</div>
    </div>
  );
}

export function LoginPage(): ReactNode {
  const { login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [submitting, setSubmitting] = useState(false);

  const fieldErrors = issuesFrom(error);
  /*
   * Where the guard bounced them from, so a deep link survives the login.
   *
   * The fallback is `/chat`, and it used to be `/dashboard` — which contradicted the other two
   * places that decide where the app opens. `App.tsx` redirects `/` to `/chat` and
   * `RedirectIfAuthenticated` sends a signed-in visitor to `/chat`, both on the stated ground that
   * the product is conversation-first; signing in and landing on a page of counts meant the first
   * thing a returning user saw was not the thing they came back for. A default that only holds on
   * three of the four paths into the app is not a default.
   */
  const from = (location.state as { from?: string } | null)?.from ?? '/chat';

  const onSubmit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await login({ email, password });
      navigate(from, { replace: true });
    } catch (err) {
      setError(err);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <AuthShell
      title="Sign in"
      subtitle="Use the account for this workspace."
      footer={
        <>
          No account? <Link to="/signup">Create one</Link>
        </>
      }
    >
      <form className="stack" onSubmit={(event) => void onSubmit(event)}>
        <FormError error={error} fieldErrors={fieldErrors} />

        <Field label="Email" error={fieldErrors.email}>
          <input
            className="input"
            type="email"
            autoComplete="username"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </Field>

        <Field label="Password" error={fieldErrors.password}>
          <input
            className="input"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </Field>

        <Button type="submit" variant="primary" loading={submitting} className="btn-block">
          {submitting ? 'Signing in…' : 'Sign in'}
        </Button>
      </form>
    </AuthShell>
  );
}

export function SignupPage(): ReactNode {
  const { signup } = useAuth();
  const navigate = useNavigate();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [tenantName, setTenantName] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [submitting, setSubmitting] = useState(false);

  const fieldErrors = issuesFrom(error);

  const onSubmit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await signup({
        email,
        password,
        name,
        // Omitted rather than sent empty: the schema allows `undefined` and rejects `''`.
        ...(tenantName.trim().length > 0 ? { tenantName: tenantName.trim() } : {}),
      });
      // Same default as the login form, and for the same reason: a new workspace is a prompt
      // waiting for its first message, not a dashboard of zeros.
      navigate('/chat', { replace: true });
    } catch (err) {
      setError(err);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <AuthShell
      title="Create an account"
      subtitle="This creates a new workspace, with you as its first member."
      footer={
        <>
          Already have an account? <Link to="/login">Sign in</Link>
        </>
      }
    >
      <form className="stack" onSubmit={(event) => void onSubmit(event)}>
        <FormError error={error} fieldErrors={fieldErrors} />

        <Field label="Your name" error={fieldErrors.name}>
          <input
            className="input"
            autoComplete="name"
            required
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </Field>

        <Field label="Email" error={fieldErrors.email}>
          <input
            className="input"
            type="email"
            autoComplete="username"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </Field>

        <Field
          label="Password"
          hint={`At least ${PASSWORD_MIN_LENGTH} characters.`}
          error={fieldErrors.password}
        >
          <input
            className="input"
            type="password"
            autoComplete="new-password"
            required
            minLength={PASSWORD_MIN_LENGTH}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </Field>

        <Field
          label="Workspace name"
          hint="Optional. Defaults to your name."
          error={fieldErrors.tenantName}
        >
          <input
            className="input"
            value={tenantName}
            onChange={(event) => setTenantName(event.target.value)}
          />
        </Field>

        <Button type="submit" variant="primary" loading={submitting} className="btn-block">
          {submitting ? 'Creating…' : 'Create account'}
        </Button>
      </form>
    </AuthShell>
  );
}
