"use client"

import { ButtonLink } from "@/components/ui/button-link"
import { TextAnimate } from "@/components/ui/text-animate"
import { motion } from "motion/react"


const Cta = () => {
    return (
        <section className="pb-20 lg:pb-32 lg:pt-12">
            <div className=" max-w-7xl mx-auto flex flex-col items-center">
                <div className=" flex flex-col items-center">
                    <TextAnimate
                        className="text-4xl md:text-5xl tracking-tight text-balance text-center"
                        animation="blurIn"
                        as="h2"
                        segmentClassName={(segment) => segment === "green" ? "text-primary" : ""}
                    >
                        Bring one public health endpoint that matters
                    </TextAnimate>
                    <TextAnimate className="mt-4 max-w-prose tracking-tight text-balance text-muted-foreground text-sm lg:text-base text-center font-sans" animation="blurInUp" as="p">
                        Create your workspace, connect one customer-owned public HTTPS GET outcome or health endpoint, and run the first structural check. Start on Free and upgrade only when you need more client coverage.
                    </TextAnimate>
                    <motion.div
                        initial={{ opacity: 0, y: 20, filter: "blur(10px)" }}
                        whileInView={{ opacity: 1, y: 0, filter: "blur(0px)" }}
                        viewport={{ once: true }}
                        transition={{ duration: 0.4, delay: 0.4 }}
                        className=" inline-flex items-center gap-4 mt-4">
                        <ButtonLink href="/sign-up" data-signup-cta="home_closing">Start monitoring free</ButtonLink>
                    </motion.div>
                </div>
            </div>
        </section>
    )
}

export default Cta
