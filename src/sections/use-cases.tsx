import { TextAnimate } from "@/components/ui/text-animate"
import { IconTrendingUp } from "@tabler/icons-react"

const UseCases = () => {
    return (
        <section id="use-cases" className="pt-20">
            <div className="max-w-7xl mx-auto flex flex-col items-center px-4 md:px-12 xl:px-0">
                <TextAnimate className="mb-4 tracking-tight text-balance text-center text-4xl md:text-5xl font-sans" animation="blurInUp" as="h2">
                    Monitor the public outcome endpoints that represent critical journeys
                </TextAnimate>

                <TextAnimate className="max-w-prose tracking-tight text-balance text-muted-foreground text-sm lg:text-base text-center font-sans" animation="blurInUp" as="p">
                    Start with customer-owned public health or outcome endpoints for the workflows where a missing signal creates lost value, emergency support, or a client escalation.
                </TextAnimate>

                <div className="my-12 z-10 grid md:grid-cols-2 gap-4 relative gap-x-4 gap-y-4 w-full">
                    <div className="overflow-hidden lg:p-8 flex flex-col items-start bg-linear-to-br from-muted to-background/0 border rounded-md lg:rounded-xl px-6 py-6 relative shadow-2xl h-full">
                        <div className="px-3 py-1 md:py-1.5 w-fit rounded-full bg-primary/20 text-sm text-foreground mb-4">
                            Lead capture
                        </div>
                        <h4 className="text-xl md:text-2xl text-foreground leading-7 font-sans">Lead-intake outcome endpoint</h4>
                        <p className="text-muted-foreground mt-4 text-sm lg:text-base flex-1">
                            Monitor a public endpoint your customer uses to summarize lead-intake health. Maintain Flow checks the endpoint signal; it does not submit leads or query the CRM.
                        </p>
                        <div className="mt-8 flex items-center gap-2 text-primary text-sm lg:text-base">
                            <IconTrendingUp className="size-4 md:size-5" />
                            <span>Catch a missing or malformed health signal early</span>
                        </div>
                    </div>

                    <div className="overflow-hidden lg:p-8 flex flex-col items-start bg-linear-to-br from-muted to-background/0 border rounded-md lg:rounded-xl px-6 py-6 relative shadow-2xl h-full">
                        <div className="px-3 py-1 md:py-1.5 w-fit rounded-full bg-primary/20 text-sm text-foreground mb-4">
                            Payment to access
                        </div>
                        <h4 className="text-xl md:text-2xl text-foreground leading-7 font-sans">Payment-flow health endpoint</h4>
                        <p className="text-muted-foreground mt-4 text-sm lg:text-base flex-1">
                            Monitor a public health endpoint maintained by the customer for its payment workflow. Maintain Flow does not create payments or inspect private entitlement records.
                        </p>
                        <div className="mt-8 flex items-center gap-2 text-primary text-sm lg:text-base">
                            <IconTrendingUp className="size-4 md:size-5" />
                            <span>Track the published payment-flow signal</span>
                        </div>
                    </div>

                    <div className="overflow-hidden lg:p-8 flex flex-col items-start bg-linear-to-br from-muted to-background/0 border rounded-md lg:rounded-xl px-6 py-6 relative shadow-2xl h-full">
                        <div className="px-3 py-1 md:py-1.5 w-fit rounded-full bg-primary/20 text-sm text-foreground mb-4">
                            AI support routing
                        </div>
                        <h4 className="text-xl md:text-2xl text-foreground leading-7 font-sans">AI-service health endpoint</h4>
                        <p className="text-muted-foreground mt-4 text-sm lg:text-base flex-1">
                            Monitor a public endpoint that the customer exposes for AI-service health. Model scoring, tool-choice evaluation, and private queue inspection are not launch capabilities.
                        </p>
                        <div className="mt-8 flex items-center gap-2 text-primary text-sm lg:text-base">
                            <IconTrendingUp className="size-4 md:size-5" />
                            <span>Separate endpoint failure from runner error</span>
                        </div>
                    </div>

                    <div className="overflow-hidden lg:p-8 flex flex-col items-start bg-linear-to-br from-muted to-background/0 border rounded-md lg:rounded-xl px-6 py-6 relative shadow-2xl h-full">
                        <div className="px-3 py-1 md:py-1.5 w-fit rounded-full bg-primary/20 text-sm text-foreground mb-4">
                            Scheduled reporting
                        </div>
                        <h4 className="text-xl md:text-2xl text-foreground leading-7 font-sans">Reporting-job health endpoint</h4>
                        <p className="text-muted-foreground mt-4 text-sm lg:text-base flex-1">
                            Monitor the public health signal for a scheduled reporting job. Maintain Flow does not open generated files, inspect inboxes, or confirm private delivery.
                        </p>
                        <div className="mt-8 flex items-center gap-2 text-primary text-sm lg:text-base">
                            <IconTrendingUp className="size-4 md:size-5" />
                            <span>Catch a failed or slow published health signal</span>
                        </div>
                    </div>
                </div>
            </div>
        </section>
    )
}

export default UseCases
