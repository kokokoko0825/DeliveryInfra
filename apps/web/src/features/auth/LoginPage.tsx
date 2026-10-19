export default function LoginPage() { return <Page title="ログイン" description="Okta またはメールアドレスでログインします。" />; }
function Page({ title, description }: { title: string; description: string }) { return <section><h1>{title}</h1><p>{description}</p></section>; }
