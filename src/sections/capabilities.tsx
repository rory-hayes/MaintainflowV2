import { TextAnimate } from "@/components/ui/text-animate"
import { IconBrain, IconChartHistogram, IconProgressBolt, IconShieldLock, IconTarget, IconTournament } from "@tabler/icons-react"

const capabilityCardClass = "overflow-hidden lg:p-8 bg-linear-to-br from-muted to-background/0 border rounded-md lg:rounded-xl px-6 py-6 relative shadow-2xl h-full"

const Capabilities = () => {
    return (
        <section id="capabilities" className=" py-8 px-4 md:px-12 xl:px-0">
            <div className=" max-w-7xl mx-auto flex flex-col items-center">
                <TextAnimate className="mb-4 tracking-tight text-balance text-center text-4xl md:text-5xl font-sans" animation="blurInUp" as="h2">
                    The assurance loop agencies can sell
                </TextAnimate>

                <TextAnimate className="max-w-prose tracking-tight text-balance text-muted-foreground text-sm lg:text-base text-center font-sans" animation="blurInUp" as="p">
                    Map a small number of critical journeys to customer-owned public outcome or health endpoints, collect safe structural evidence, triage exceptions, and produce client-safe proof.
                </TextAnimate>

                <div className="my-12 z-10 grid md:grid-cols-3 gap-4 relative gap-x-4 gap-y-4">
                    <div className={capabilityCardClass}>
                        <div className="size-12 lg:size-14 bg-muted flex items-center justify-center rounded-xl">
                            <IconTarget className="size-6 lg:size-8" />
                        </div>
                        <h4 className="mt-8 text-xl text-foreground leading-7 font-sans">Public outcome endpoints</h4>
                        <p className="text-muted-foreground mt-2 text-sm lg:text-base">Check a customer-owned public HTTPS GET endpoint independently of the automation platform&apos;s own run history.</p>
                    </div>

                    <div className={capabilityCardClass}>
                        <div className="size-12 lg:size-14 bg-muted flex items-center justify-center rounded-xl">
                            <IconTournament className="size-6 lg:size-8" />
                        </div>
                        <h4 className="mt-8 text-xl text-foreground leading-7 font-sans">Structural assertions</h4>
                        <p className="text-muted-foreground mt-2 text-sm lg:text-base">Verify status, latency, response existence, and short JSON-field paths without storing values or raw responses.</p>
                    </div>

                    <div className={capabilityCardClass}>
                        <div className="size-12 lg:size-14 bg-muted flex items-center justify-center rounded-xl">
                            <IconBrain className="size-6 lg:size-8" />
                        </div>
                        <h4 className="mt-8 text-xl text-foreground leading-7 font-sans">Conclusive run states</h4>
                        <p className="text-muted-foreground mt-2 text-sm lg:text-base">Keep passing, failed or degraded endpoint results, and inconclusive runner errors distinct so the signal stays credible.</p>
                    </div>
                    <div className={capabilityCardClass}>
                        <div className="size-12 lg:size-14 bg-muted flex items-center justify-center rounded-xl">
                            <IconProgressBolt className="size-6 lg:size-8" />
                        </div>
                        <h4 className="mt-8 text-xl text-foreground leading-7 font-sans">Evidence-backed incidents</h4>
                        <p className="text-muted-foreground mt-2 text-sm lg:text-base">Attach the failed outcome and client impact before an issue enters the agency queue.</p>
                    </div>
                    <div className={capabilityCardClass}>
                        <div className="size-12 lg:size-14 bg-muted flex items-center justify-center rounded-xl">
                            <IconShieldLock className="size-6 lg:size-8" />
                        </div>
                        <h4 className="mt-8 text-xl text-foreground leading-7 font-sans">Post-repair reruns</h4>
                        <p className="text-muted-foreground mt-2 text-sm lg:text-base">Record the same approved journey passing again after the customer or agency performs a repair.</p>
                    </div>
                    <div className={capabilityCardClass}>
                        <div className="size-12 lg:size-14 bg-muted flex items-center justify-center rounded-xl">
                            <IconChartHistogram className="size-6 lg:size-8" />
                        </div>
                        <h4 className="mt-8 text-xl text-foreground leading-7 font-sans">White-label evidence</h4>
                        <p className="text-muted-foreground mt-2 text-sm lg:text-base">Turn protected journeys, incidents, repairs, and passing verification into a client-ready Reliability Report.</p>
                    </div>
                </div>
            </div>
        </section>
    )
}

export default Capabilities
