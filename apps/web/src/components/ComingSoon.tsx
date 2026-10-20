export function ComingSoon({ title, subproject, about }: { title: string; subproject: number; about: string }) {
  return (
    <div className="mx-auto max-w-xl py-24 text-center">
      <h1 className="text-2xl font-semibold">{title}</h1>
      <p className="mt-2 text-muted-foreground">{about}</p>
      <p className="mt-6 inline-block rounded-full bg-muted px-3 py-1 text-sm">Скоро: підпроєкт {subproject}</p>
    </div>
  );
}
