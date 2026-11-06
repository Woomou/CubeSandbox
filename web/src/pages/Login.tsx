// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Tencent. All rights reserved.

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation, useNavigate } from 'react-router-dom';
import { LogIn, Loader2, Cuboid } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { authApi } from '@/api/client';
import { setSession } from '@/lib/session';

export default function LoginPage() {
  const { t } = useTranslation('auth');
  const navigate = useNavigate();
  const location = useLocation();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const redirectTo = (location.state as { from?: string } | null)?.from ?? '/';

  const completeSSO = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const res = await authApi.sso();
      setSession(res.accessToken, res.refreshToken, res.username);
      navigate(redirectTo, { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : t('login.error'));
    } finally {
      setSubmitting(false);
    }
  };

  useEffect(() => {
    if (new URLSearchParams(location.search).get('sso') === '1') void completeSSO();
  }, []);

  const startSSO = () => {
    window.location.assign('/oauth2/start?rd=%2Flogin%3Fsso%3D1');
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex flex-col items-center text-center">
          <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-primary/10 text-primary">
            <Cuboid size={24} />
          </span>
          <h1 className="mt-3 text-xl font-semibold tracking-tight">{t('login.title')}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{t('login.subtitle')}</p>
        </div>

        <div className="space-y-4 rounded-2xl border border-border/60 bg-card p-6 shadow-sm">
          {error && <p className="text-sm text-rose-500">{error}</p>}

          <Button type="button" className="w-full gap-2" disabled={submitting} onClick={startSSO}>
            {submitting ? <Loader2 size={16} className="animate-spin" /> : <LogIn size={16} />}
            {submitting ? t('login.submitting') : t('login.ssoSubmit')}
          </Button>
          <p className="text-center text-xs text-muted-foreground">{t('login.ssoHint')}</p>
        </div>
      </div>
    </div>
  );
}
