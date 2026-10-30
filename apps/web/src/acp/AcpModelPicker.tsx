import { RiRobot2Line } from "@remixicon/react";
import type { AcpConfigOption } from "@thinkrail/contracts";
import { ACP_MODEL_CATALOG_PROTOCOL_VERSION } from "@thinkrail/contracts";
import { useT } from "@thinkrail/locales/react";
import { IconButton } from "@thinkrail/ui/button";
import {
	Command,
	CommandEmpty,
	CommandGroup,
	CommandInput,
	CommandItem,
	CommandList,
} from "@thinkrail/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@thinkrail/ui/popover";
import { useEffect, useRef, useState } from "react";
import { useAppStore } from "../store";
import { getTransport } from "../transport";
import { createAcpChatInTab } from "./openAcpChat";

export function AcpModelPicker({ workspaceId }: { workspaceId: string }) {
	const t = useT();
	const status = useAppStore((state) => state.status);
	const protocolVersion = useAppStore((state) => state.protocolVersion);
	const connectionGeneration = useAppStore((state) => state.connectionGeneration);
	const clients = useAppStore((state) => state.acpClients);
	const [open, setOpen] = useState(false);
	const [loadingClientId, setLoadingClientId] = useState<string | null>(null);
	const [busyClientId, setBusyClientId] = useState<string | null>(null);
	const [catalogs, setCatalogs] = useState<Record<string, AcpConfigOption[]>>({});
	const [failedClientIds, setFailedClientIds] = useState<Record<string, true>>({});
	const [startFailed, setStartFailed] = useState(false);
	const pickerOpenRef = useRef(false);
	const discoveryRunRef = useRef(0);
	const catalogGenerationRef = useRef(0);
	const modelRequestRef = useRef<{
		clientId: string;
		token: symbol;
		promise: Promise<void>;
	} | null>(null);
	const enabledClients = clients.filter((client) => client.enabled);
	const supported =
		status === "connected" &&
		protocolVersion !== null &&
		protocolVersion >= ACP_MODEL_CATALOG_PROTOCOL_VERSION;

	useEffect(() => {
		catalogGenerationRef.current += 1;
		discoveryRunRef.current += 1;
		pickerOpenRef.current = false;
		modelRequestRef.current = null;
		setOpen(false);
		setCatalogs({});
		setFailedClientIds({});
		setLoadingClientId(null);
		setBusyClientId(null);
		setStartFailed(false);
	}, [clients, connectionGeneration, workspaceId]);

	if (!supported || enabledClients.length === 0) return null;

	const listModels = (clientId: string): Promise<void> => {
		if (busyClientId !== null) return Promise.resolve();
		const activeRequest = modelRequestRef.current;
		if (activeRequest) {
			return activeRequest.clientId === clientId
				? activeRequest.promise
				: activeRequest.promise.then(() => listModels(clientId));
		}

		const generation = catalogGenerationRef.current;
		const token = Symbol();
		setLoadingClientId(clientId);
		setFailedClientIds((current) => {
			const next = { ...current };
			delete next[clientId];
			return next;
		});
		const promise = getTransport()
			.request("acp.client.models", { workspaceId, clientId })
			.then((options) => {
				if (generation === catalogGenerationRef.current) {
					setCatalogs((current) => ({ ...current, [clientId]: options }));
				}
			})
			.catch(() => {
				if (generation === catalogGenerationRef.current) {
					setFailedClientIds((current) => ({ ...current, [clientId]: true }));
				}
			})
			.finally(() => {
				if (modelRequestRef.current?.token !== token) return;
				modelRequestRef.current = null;
				if (generation === catalogGenerationRef.current) setLoadingClientId(null);
			});
		modelRequestRef.current = { clientId, token, promise };
		return promise;
	};

	const discoverModels = () => {
		const generation = catalogGenerationRef.current;
		const run = ++discoveryRunRef.current;
		void (async () => {
			for (const client of enabledClients) {
				if (
					!pickerOpenRef.current ||
					run !== discoveryRunRef.current ||
					generation !== catalogGenerationRef.current
				) {
					return;
				}
				if (catalogs[client.id] === undefined) await listModels(client.id);
			}
		})();
	};

	const chooseModel = (clientId: string, configOptionId: string, value: string) => {
		if (busyClientId !== null || loadingClientId !== null) return;
		setBusyClientId(clientId);
		setStartFailed(false);
		void createAcpChatInTab(workspaceId, clientId, undefined, {
			configId: configOptionId,
			value,
		})
			.then((opened) => {
				if (opened) {
					pickerOpenRef.current = false;
					discoveryRunRef.current += 1;
					setOpen(false);
				} else setStartFailed(true);
			})
			.catch(() => setStartFailed(true))
			.finally(() => setBusyClientId(null));
	};

	return (
		<Popover
			open={open}
			onOpenChange={(nextOpen) => {
				if (busyClientId !== null) return;
				pickerOpenRef.current = nextOpen;
				setOpen(nextOpen);
				if (nextOpen) discoverModels();
				else discoveryRunRef.current += 1;
			}}
		>
			<PopoverTrigger asChild>
				<IconButton
					icon={RiRobot2Line}
					label={t("chat.acpPicker.open")}
					data-testid="acp-model-picker-trigger"
				/>
			</PopoverTrigger>
			<PopoverContent
				align="end"
				className="w-[min(24rem,calc(100vw-16px))] p-0"
				data-testid="acp-model-picker"
			>
				<Command className="min-h-0 bg-transparent">
					<CommandInput placeholder={t("chat.acpPicker.search")} />
					<CommandList className="max-h-[min(50dvh,24rem)]">
						<CommandEmpty>{t("chat.acpPicker.noMatches")}</CommandEmpty>
						{enabledClients.map((client) => {
							const options = catalogs[client.id];
							return (
								<CommandGroup key={client.id} heading={client.name}>
									{failedClientIds[client.id] ? (
										<CommandItem
											value={`${client.name} ${t("chat.acpPicker.loadFailed")} ${t("chat.acpPicker.retry")}`}
											disabled={loadingClientId !== null || busyClientId !== null}
											data-testid={`acp-models-retry-${client.id}`}
											onSelect={() => void listModels(client.id)}
										>
											{t("chat.acpPicker.loadFailed")} {t("chat.acpPicker.retry")}
										</CommandItem>
									) : options === undefined ? (
										<CommandItem
											value={`${client.name} ${t("chat.acpPicker.listModels")}`}
											disabled={loadingClientId !== null || busyClientId !== null}
											data-testid={`acp-models-discover-${client.id}`}
											onSelect={() => void listModels(client.id)}
										>
											{loadingClientId === client.id
												? t("chat.acpPicker.loadingModels")
												: t("chat.acpPicker.listModels")}
										</CommandItem>
									) : options.length === 0 ? (
										<CommandItem value={`${client.id} ${t("chat.acpPicker.noModels")}`} disabled>
											{t("chat.acpPicker.noModels")}
										</CommandItem>
									) : (
										options.flatMap((option) =>
											option.options.map((choice) => (
												<CommandItem
													key={`${option.id}:${choice.value}`}
													value={`${client.name} ${option.name} ${choice.name} ${choice.value}`}
													keywords={[option.id, option.name, choice.name, choice.value]}
													disabled={busyClientId !== null || loadingClientId !== null}
													data-testid="acp-model-option"
													data-client-id={client.id}
													data-config-id={option.id}
													data-model-value={choice.value}
													onSelect={() => chooseModel(client.id, option.id, choice.value)}
												>
													<span className="min-w-0 flex-1 truncate">
														{option.options.length > 1 || options.length > 1
															? `${option.name}: ${choice.name || choice.value}`
															: choice.name || choice.value}
													</span>
													{busyClientId === client.id ? t("chat.acpPicker.opening") : null}
												</CommandItem>
											)),
										)
									)}
								</CommandGroup>
							);
						})}
					</CommandList>
				</Command>
				<div className="flex flex-col gap-4 border-border-default border-t px-8 py-8">
					{startFailed ? (
						<p role="alert" className="text-feedback-error tr-text-metadata">
							{t("chat.acpPicker.startFailed")}
						</p>
					) : null}
					<p className="text-text-muted tr-text-metadata">{t("chat.acpPicker.opensChat")}</p>
				</div>
			</PopoverContent>
		</Popover>
	);
}
