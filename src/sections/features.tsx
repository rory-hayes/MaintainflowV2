import { IconCheck } from "@tabler/icons-react";

const featureCardClassName =
    "min-h-80 md:min-h-none overflow-hidden lg:p-8 bg-linear-to-br from-muted to-background/0 border rounded-md lg:rounded-xl px-6 py-6 relative h-full";

export const Features = () => {
    return (
        <section id="features" className="pt-24 pb-24 relative overflow-hidden">
            <div className="max-w-7xl mx-auto px-4 md:px-12 xl:px-0">
                <div className="flex flex-col md:flex-row md:items-end pb-8 gap-x-6 gap-y-6 items-center justify-between">
                    <div className="max-w-2xl">
                        <h2 className="text-4xl md:text-5xl text-foreground mb-4 text-center md:text-left">
                            A green automation run is not a <span className="text-primary">healthy outcome signal</span>
                        </h2>
                        <p className="text-muted-foreground text-sm lg:text-base text-center md:text-left md:text-balance font-sans">
                            Native run history tells you what the automation platform saw. Maintain Flow independently checks a customer-owned public outcome or health endpoint that represents the journey.
                        </p>
                    </div>
                </div>

                <div className="max-w-7xl mx-auto mt-8 mb-12 z-10 grid md:grid-cols-2 gap-4 relative gap-x-4 gap-y-4">
                    <div className={featureCardClassName}>
                        <div className="max-w-sm z-10 relative">
                            <h3 className=" text-xl md:text-2xl text-foreground leading-7 font-sans">Check a customer-owned public endpoint</h3>
                            <p className="text-muted-foreground mt-2 text-sm lg:text-base">Monitor an approved public HTTPS GET endpoint without storing credentials, custom headers, query parameters, or a request body.</p>
                            <ul className="mt-8 space-y-3">
                                <li className="flex items-center gap-2 text-sm lg:text-base text-foreground">
                                    <IconCheck className="h-4 w-4 text-primary" />
                                    Public HTTPS GET only
                                </li>
                                <li className="flex items-center gap-2 text-sm lg:text-base text-foreground">
                                    <IconCheck className="h-4 w-4 text-primary" />
                                    Manual or scheduled checks
                                </li>
                                <li className="flex items-center gap-2 text-sm lg:text-base text-foreground">
                                    <IconCheck className="h-4 w-4 text-primary" />
                                    Independent endpoint evidence
                                </li>
                            </ul>
                        </div>
                        <div className="absolute top-6 -right-8 translate-x-12 translate-y-8 w-64 h-64 opacity-90 transition-transform duration-700 ease-out group-hover:scale-110 group-hover:-translate-y-4 group-hover:-translate-x-2">
                            <svg viewBox="0 0 200 200" fill="none" xmlns="http://www.w3.org/2000/svg" className="w-full h-full drop-shadow-2xl">
                                <g className="transition-transform duration-700 ease-out group-hover:rotate-3 origin-center">
                                    <ellipse cx="100" cy="100" rx="50" ry="45" fill="#27272a" className="transition-colors duration-500 group-hover:fill-[#3f3f46]"></ellipse>
                                    <ellipse cx="100" cy="95" rx="50" ry="45" fill="#3f3f46" className="transition-colors duration-500 group-hover:fill-[#52525b]"></ellipse>
                                    <path d="M70 80 Q100 70 130 80" stroke="#0065FC" strokeWidth="2" opacity="0.6" className="transition-opacity duration-500 group-hover:opacity-100"></path>
                                    <path d="M70 100 Q100 90 130 100" stroke="#4D94FF" strokeWidth="2" opacity="0.6" className="transition-opacity duration-500 group-hover:opacity-100"></path>
                                    <path d="M70 120 Q100 110 130 120" stroke="#4D94FF" strokeWidth="2" opacity="0.6" className="transition-opacity duration-500 group-hover:opacity-100"></path>
                                </g>
                                <g className="transition-transform duration-700 ease-out group-hover:-translate-y-2">
                                    <circle cx="100" cy="70" r="5" fill="#0065FC" className="drop-shadow-[0_0_8px_rgba(168,85,247,0.5)]"></circle>
                                    <circle cx="80" cy="90" r="4" fill="#4D94FF" className="drop-shadow-[0_0_8px_rgba(124,58,237,0.5)]"></circle>
                                    <circle cx="120" cy="90" r="4" fill="#4D94FF" className="drop-shadow-[0_0_8px_rgba(147,51,234,0.5)]"></circle>
                                </g>
                            </svg>
                        </div>
                    </div>

                    <div className={featureCardClassName}>
                        <div className="max-w-sm z-10 relative">
                            <h3 className=" text-xl md:text-2xl text-foreground leading-7 font-sans">Verify safe structural evidence</h3>
                            <p className="text-muted-foreground mt-2 text-sm lg:text-base ">Check the expected HTTP status, latency threshold, response existence, and bounded JSON-field existence. Maintain Flow does not log in to downstream systems at launch.</p>
                        </div>
                        <div className="absolute top-0 -right-6 translate-x-16 translate-y-16 w-72 h-72 transition-transform duration-700 ease-out group-hover:scale-105 group-hover:-translate-x-4 group-hover:-translate-y-4">
                            <svg viewBox="0 0 300 300" fill="none" xmlns="http://www.w3.org/2000/svg" className="w-full h-full">
                                <g className="transition-transform duration-700 ease-out group-hover:translate-y-4 group-hover:opacity-60">
                                    <path d="M150 240 L50 190 L150 140 L250 190 Z" fill="#18181b" stroke="#27272a" strokeWidth="2"></path>
                                    <path d="M50 190 V210 L150 260 L250 210 V190" fill="#18181b" fillOpacity="0.5"></path>
                                </g>
                                <path d="M150 200 L50 150 L150 100 L250 150 Z" fill="#27272a" stroke="#3f3f46" strokeWidth="2" opacity="0.8" className="transition-transform duration-700 ease-out group-hover:translate-y-0"></path>
                                <g className="transition-transform duration-700 ease-out group-hover:-translate-y-6">
                                    <path d="M150 160 L210 130 L270 160 L210 190 Z" fill="#0065FC" className="transition-colors duration-500 group-hover:fill-[#A9CCFF]"></path>
                                    <path d="M210 190 V200 L270 170 V160" fill="#4D94FF"></path>
                                    <path d="M150 160 V170 L210 200 V190" fill="#4D94FF"></path>
                                </g>
                            </svg>
                        </div>
                    </div>

                    <div className={featureCardClassName}>
                        <div className="max-w-sm z-10 relative">
                            <h3 className=" text-xl md:text-2xl text-foreground leading-7 font-sans">Separate failures from test errors</h3>
                            <p className="text-muted-foreground mt-2 text-sm lg:text-base ">Keep real broken outcomes distinct from access, runner, or setup errors before noise becomes a client incident.</p>
                            <ul className="mt-8 space-y-3">
                                <li className="flex items-center gap-2 text-sm lg:text-base text-foreground">
                                    <IconCheck className="h-4 w-4 text-primary" />
                                    Evidence attached to every result
                                </li>
                                <li className="flex items-center gap-2 text-sm lg:text-base text-foreground">
                                    <IconCheck className="h-4 w-4 text-primary" />
                                    Inconclusive runs kept separate
                                </li>
                                <li className="flex items-center gap-2 text-sm lg:text-base text-foreground">
                                    <IconCheck className="h-4 w-4 text-primary" />
                                    Named evidence provenance
                                </li>
                            </ul>
                        </div>
                        <div className="absolute top-12 md:top-0 -right-16 md:-right-4 translate-x-10 translate-y-10 w-64 h-64 transition-transform duration-700 ease-out group-hover:scale-105 group-hover:-translate-y-2 group-hover:-translate-x-2">
                            <svg viewBox="0 0 200 200" fill="none" xmlns="http://www.w3.org/2000/svg" className="w-full h-full">
                                <path d="M100 40 L100 80" stroke="#0065FC" strokeWidth="3" className="transition-opacity duration-500 group-hover:opacity-100" opacity="0.6"></path>
                                <path d="M100 80 L70 110" stroke="#4D94FF" strokeWidth="2.5" className="transition-opacity duration-500 group-hover:opacity-100" opacity="0.6"></path>
                                <path d="M100 80 L130 110" stroke="#4D94FF" strokeWidth="2.5" className="transition-opacity duration-500 group-hover:opacity-100" opacity="0.6"></path>
                                <path d="M70 110 L55 135" stroke="#0065FC" strokeWidth="2" opacity="0.5"></path>
                                <path d="M70 110 L85 135" stroke="#0065FC" strokeWidth="2" opacity="0.5"></path>
                                <path d="M130 110 L115 135" stroke="#4D94FF" strokeWidth="2" opacity="0.5"></path>
                                <path d="M130 110 L145 135" stroke="#4D94FF" strokeWidth="2" opacity="0.5"></path>
                                <g className="transition-transform duration-500 cubic-bezier(0.34, 1.56, 0.64, 1) group-hover:-translate-y-3">
                                    <circle cx="100" cy="40" r="12" fill="#0065FC" className="drop-shadow-[0_0_12px_rgba(168,85,247,0.6)]"></circle>
                                    <circle cx="100" cy="80" r="10" fill="#4D94FF" className="drop-shadow-[0_0_10px_rgba(147,51,234,0.6)]"></circle>
                                    <circle cx="70" cy="110" r="8" fill="#4D94FF" className="drop-shadow-[0_0_8px_rgba(124,58,237,0.6)]"></circle>
                                    <circle cx="130" cy="110" r="8" fill="#4D94FF" className="drop-shadow-[0_0_8px_rgba(124,58,237,0.6)]"></circle>
                                </g>
                                <circle cx="55" cy="135" r="5" fill="#A9CCFF" opacity="0.8"></circle>
                                <circle cx="85" cy="135" r="5" fill="#A9CCFF" opacity="0.8"></circle>
                                <circle cx="115" cy="135" r="5" fill="#A9CCFF" opacity="0.8"></circle>
                                <circle cx="145" cy="135" r="5" fill="#A9CCFF" opacity="0.8"></circle>
                            </svg>
                        </div>
                    </div>

                    <div className={featureCardClassName}>
                        <div className="max-w-sm z-10 relative">
                            <h3 className=" text-xl md:text-2xl text-foreground leading-7 font-sans">Rerun after the repair and show the work</h3>
                            <p className="text-muted-foreground mt-2 text-sm lg:text-base">A note cannot close the loop. The same approved journey must pass after a customer-performed repair before the report describes the post-repair state as passing.</p>
                        </div>
                        <div className="absolute bottom-0 right-0 w-full h-full pointer-events-none">
                            <div className="absolute -top-8 right-0 translate-x-16 translate-y-12 w-80 h-80 transition-transform duration-700 ease-out group-hover:scale-105 group-hover:translate-x-8 group-hover:translate-y-4">
                                <svg viewBox="0 0 200 200" fill="none" xmlns="http://www.w3.org/2000/svg" className="w-full h-full drop-shadow-2xl">
                                    <path d="M100 160 L30 125 L100 90 L170 125 Z" fill="#18181b" stroke="#27272a" strokeWidth="1" className="transition-colors duration-500 group-hover:fill-[#27272a] group-hover:stroke-[#3f3f46]"></path>
                                    <path d="M30 125 V140 L100 175 L170 140 V125" fill="#18181b" fillOpacity="0.6"></path>
                                    <path d="M100 90 V160" stroke="#0065FC" strokeWidth="2" strokeDasharray="4 4" opacity="0.3" className="transition-opacity duration-500 group-hover:opacity-60"></path>
                                    <circle cx="100" cy="125" r="30" stroke="#3f3f46" strokeWidth="1" opacity="0.3" transform="scale(1 0.5)"></circle>
                                    <g className="transition-transform duration-700 ease-out group-hover:-translate-y-6 group-hover:rotate-3 origin-center">
                                        <path d="M100 80 L60 60 L100 40 L140 60 Z" fill="#4D94FF" className="transition-colors duration-500 group-hover:fill-[#0065FC]"></path>
                                        <path d="M60 60 V90 L100 110 V80 L60 60 Z" fill="#4D94FF" className="transition-colors duration-500 group-hover:fill-[#0065FC]"></path>
                                        <path d="M140 60 V90 L100 110 V80 L140 60 Z" fill="#00598A" className="transition-colors duration-500 group-hover:fill-[#4D94FF]"></path>
                                    </g>
                                    <circle cx="150" cy="50" r="4" fill="#A9CCFF" className="transition-transform duration-1000 ease-in-out group-hover:translate-y-2 group-hover:-translate-x-2" opacity="0.8"></circle>
                                    <circle cx="50" cy="100" r="3" fill="#0065FC" className="transition-transform duration-1000 ease-in-out group-hover:-translate-y-4 group-hover:translate-x-2" opacity="0.6"></circle>
                                </svg>
                            </div>
                        </div>
                    </div>

                </div>
            </div>
        </section>
    )
}

export default Features
