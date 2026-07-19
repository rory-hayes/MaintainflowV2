"use client"

import { ButtonLink } from "@/components/ui/button-link"
import { IconAlertTriangle, IconCircleCheck, IconReportAnalytics } from "@tabler/icons-react"
import Image from "next/image"

const Hero = () => {
    return (
        <section className="relative overflow-hidden bg-background pt-32 md:pt-40 pb-16 lg:pb-20">
            <div className="absolute inset-x-0 top-0 h-px bg-border" />
            <div className="w-full flex flex-col items-center justify-center relative px-4 md:px-12 xl:px-0">
                <div className=" flex flex-col items-center">
                    <div className="mb-5 inline-flex items-center gap-2 rounded-full border border-border bg-muted/30 px-3 py-1 text-sm text-muted-foreground">
                        <span className="size-2 rounded-full bg-primary" />
                        Self-serve public endpoint assurance for automation agencies
                    </div>
                    <h1 className="max-w-3xl text-balance text-center text-[40px] leading-10 tracking-tighter md:text-5xl lg:text-6xl lg:leading-14">
                        Monitor the public outcome signals behind critical client automations.
                    </h1>
                    <p className="mt-4 max-w-2xl text-balance text-center font-sans text-sm tracking-tight text-muted-foreground lg:text-base">
                        Connect a customer-owned public HTTPS GET outcome or health endpoint, check its status, latency, and safe response structure, then turn failures, repairs, and passing reruns into client-ready reports.
                    </p>
                    <div className="mt-6 flex flex-col items-center gap-3 sm:flex-row">
                        <ButtonLink href="/sign-up" data-signup-cta="home_hero">Start free</ButtonLink>
                        <p className="text-center text-xs leading-5 text-muted-foreground sm:max-w-56 sm:text-left">
                            No card · no sales call · no scheduled onboarding
                        </p>
                    </div>
                    <div className="mt-5 grid w-full max-w-2xl gap-2 sm:grid-cols-3">
                        <HeroSignal icon={IconAlertTriangle} label="Check a public endpoint" />
                        <HeroSignal icon={IconCircleCheck} label="Record structural evidence" />
                        <HeroSignal icon={IconReportAnalytics} label="Rerun after repair" />
                    </div>
                </div>

                <div className="max-w-7xl mx-auto w-full bg-card border border-border p-1 md:p-1.5 rounded-lg lg:rounded-xl mt-12 lg:mt-14 shadow-xl shadow-primary/5">
                    <div className="flex items-center justify-between gap-3 w-full px-2.5 md:pt-0.5 pb-1 md:pb-1.5">
                        <div className="inline-flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
                            <span className="size-2 rounded-full bg-primary" />
                            <span className="truncate">Agency assurance workspace</span>
                        </div>

                        <div className="hidden items-center gap-2 text-xs text-muted-foreground sm:inline-flex">
                            <span>Risks</span>
                            <span>Checks</span>
                            <span>Reports</span>
                        </div>
                    </div>
                    <div className="w-full aspect-[16/11] md:aspect-video rounded-md lg:rounded-lg relative overflow-hidden border border-border bg-background">
                        <Image
                            fill
                            src="/assets/maintain-flow-mature-dashboard.png"
                            alt="Maintain Flow agency assurance workspace"
                            quality={100}
                            loading="eager"
                            className="object-contain object-top rounded-lg"
                        />
                    </div>
                </div>
            </div>
        </section>
    )
}

function HeroSignal({
    icon: Icon,
    label,
}: {
    icon: typeof IconAlertTriangle
    label: string
}) {
    return (
        <div className="flex items-center justify-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-sm font-medium shadow-xs">
            <Icon aria-hidden className="text-primary" />
            {label}
        </div>
    )
}

export default Hero
