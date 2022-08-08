/* eslint-disable max-lines */
const {
	ActionRowBuilder,
	ModalBuilder,
	SelectMenuBuilder,
	SelectMenuOptionBuilder,
	TextInputBuilder,
	TextInputStyle,
} = require('discord.js');
const emoji = require('node-emoji');
const ms = require('ms');
const { EmbedBuilder } = require('discord.js');

/**
 * @typedef {import('@prisma/client').Category & {guild: import('@prisma/client').Guild} & {questions: import('@prisma/client').Question[]}} CategoryGuildQuestions
 */
module.exports = class TicketManager {
	constructor(client) {
		/** @type {import("client")} */
		this.client = client;
	}

	/**
	 * @param {object} data
	 * @param {string} data.categoryId
	 * @param {import("discord.js").ButtonInteraction|import("discord.js").SelectMenuInteraction} data.interaction
	 * @param {string?} [data.topic]
	 */
	async create({
		categoryId, interaction, topic, referencesMessage, referencesTicket,
	}) {
		const cacheKey = `cache/category+guild+questions:${categoryId}`;
		/** @type {CategoryGuildQuestions} */
		let category = await this.client.keyv.get(cacheKey);
		if (!category) {
			category = await this.client.prisma.category.findUnique({
				include: {
					guild: true,
					questions: true,
				},
				where: { id: Number(categoryId) },
			});
			if (!category) {
				let settings;
				if (interaction.guild) {
					settings = await this.client.prisma.guild.findUnique({ where: { id: interaction.guild.id } });
				} else {
					settings = {
						errorColour: 'Red',
						locale: 'en-GB',
					};
				}
				const getMessage = this.client.i18n.getLocale(settings.locale);
				const embed = new EmbedBuilder()
					.setColor(settings.errorColour)
					.setTitle(getMessage('misc.unknown_category.title'))
					.setDescription(getMessage('misc.unknown_category.description'));
				if (settings.footer) {
					embed.setFooter({
						iconURL: interaction.guild?.iconURL(),
						text: settings.footer,
					});
				}
				return await interaction.reply({
					embeds: [embed],
					ephemeral: true,
				});
			}
			this.client.keyv.set(cacheKey, category, ms('5m'));
		}

		const getMessage = this.client.i18n.getLocale(category.guild.locale);

		const rlKey = `ratelimits/guild-user:${category.guildId}-${interaction.user.id}`;
		const rl = await this.client.keyv.get(rlKey);
		if (rl) {
			const embed = new EmbedBuilder()
				.setColor(category.guild.errorColour)
				.setTitle(getMessage('misc.ratelimited.title'))
				.setDescription(getMessage('misc.ratelimited.description'));
			if (category.guild.footer) {
				embed.setFooter({
					iconURL: interaction.guild.iconURL(),
					text: category.guild.footer,
				});
			}
			return await interaction.reply({
				embeds: [embed],
				ephemeral: true,
			});
		} else {
			this.client.keyv.set(rlKey, true, ms('10s'));
		}

		// TODO: if member !required roles -> stop

		// TODO: if discordCategory has 50 channels -> stop

		// TODO: if category has max channels -> stop

		// TODO: if member has max -> stop

		// TODO: if cooldown -> stop

		if (category.questions.length >= 1) {
			await interaction.showModal(
				new ModalBuilder()
					.setCustomId(JSON.stringify({
						action: 'questions',
						categoryId,
						referencesMessage,
						referencesTicket,
					}))
					.setTitle(category.name)
					.setComponents(
						category.questions
							.filter(q => q.type === 'TEXT') // TODO: remove this when modals support select menus
							.sort((a, b) => a.order - b.order)
							.map(q => {
								if (q.type === 'TEXT') {
									return new ActionRowBuilder()
										.setComponents(
											new TextInputBuilder()
												.setCustomId(q.id)
												.setLabel(q.label)
												.setStyle(q.style)
												.setMaxLength(q.maxLength)
												.setMinLength(q.minLength)
												.setPlaceholder(q.placeholder)
												.setRequired(q.required)
												.setValue(q.value),
										);
								} else if (q.type === 'MENU') {
									return new ActionRowBuilder()
										.setComponents(
											new SelectMenuBuilder()
												.setCustomId(q.id)
												.setPlaceholder(q.placeholder || q.label)
												.setMaxValues(q.maxLength)
												.setMinValues(q.minLength)
												.setOptions(
													q.options.map((o, i) => {
														const builder = new SelectMenuOptionBuilder()
															.setValue(String(i))
															.setLabel(o.label);
														if (o.description) builder.setDescription(o.description);
														if (o.emoji) builder.setEmoji(emoji.hasEmoji(o.emoji) ? emoji.get(o.emoji) : { id: o.emoji });
														return builder;
													}),
												),
										);
								}
							}),
					),
			);
		} else if (category.requireTopic && !topic) {
			await interaction.showModal(
				new ModalBuilder()
					.setCustomId(JSON.stringify({
						action: 'topic',
						categoryId,
						referencesMessage,
						referencesTicket,
					}))
					.setTitle(category.name)
					.setComponents(
						new ActionRowBuilder()
							.setComponents(
								new TextInputBuilder()
									.setCustomId('topic')
									.setLabel(getMessage('modals.topic'))
									.setStyle(TextInputStyle.Long),
							),
					),
			);
		} else {
			await this.postQuestions({
				categoryId,
				interaction,
				topic,
			});
		}
	}

	/**
	 * @param {object} data
	 * @param {string} data.category
	 * @param {import("discord.js").ButtonInteraction|import("discord.js").SelectMenuInteraction|import("discord.js").ModalSubmitInteraction} data.interaction
	 * @param {string?} [data.topic]
	 */
	async postQuestions({
		categoryId, interaction, topic, referencesMessage, referencesTicket,
	}) {
		await interaction.deferReply({ ephemeral: true });

		const cacheKey = `cache/category+guild+questions:${categoryId}`;
		/** @type {CategoryGuildQuestions} */
		const category = await this.client.keyv.get(cacheKey);

		let answers;
		if (interaction.isModalSubmit()) {
			answers = category.questions.map(q => ({
				questionId: q.id,
				userId: interaction.user.id,
				value: interaction.fields.getTextInputValue(q.id),
			}));
			if (category.customTopic) topic = interaction.fields.getTextInputValue(category.customTopic);
		}

		/** @type {import("discord.js").Guild} */
		const guild = this.client.guilds.cache.get(category.guild.id);
		const getMessage = this.client.i18n.getLocale(category.guild.locale);
		const creator = await guild.members.fetch(interaction.user.id);
		const number = (await this.client.prisma.ticket.count({ where: { guildId: category.guild.id } })) + 1;
		const channelName = category.channelName
			.replace(/{+\s?(user)?name\s?}+/gi, creator.user.username)
			.replace(/{+\s?(nick|display)(name)?\s?}+/gi, creator.displayName)
			.replace(/{+\s?num(ber)?\s?}+/gi, number === 1488 ? '1487b' : number);
		const allow = ['ViewChannel', 'ReadMessageHistory', 'SendMessages', 'EmbedLinks', 'AttachFiles'];
		/** @type {import("discord.js").TextChannel} */
		const channel = await guild.channels.create({
			name: channelName,
			parent: category.discordCategory,
			permissionOverwrites: [
				{
					deny: ['ViewChannel'],
					id: guild.roles.everyone,
				},
				{
					allow: allow,
					id: this.client.user.id,
				},
				{
					allow: allow,
					id: creator.id,
				},
				...category.staffRoles.map(id => ({
					allow: allow,
					id,
				})),
			],
			rateLimitPerUser: category.ratelimit,
			reason: `${creator.user.tag} created a ticket`,
			topic: `${creator}${topic?.length > 0 ? ` | ${topic}` : ''}`,
		});

		const embed = new EmbedBuilder()
			.setColor(category.guild.primaryColour)
			.setAuthor({
				iconURL: creator.displayAvatarURL(),
				name: creator.displayName,
			})
			.setDescription(
				category.openingMessage
					.replace(/{+\s?(user)?name\s?}+/gi, creator.user.toString()),

			);

		if (answers) {
			embed.setFields(
				category.questions.map(q => ({
					name: q.label,
					value: interaction.fields.getTextInputValue(q.id) || getMessage('ticket.answers.no_value'),
				})),
			);
		} else if (topic) {
			embed.setFields({
				name: getMessage('ticket.opening_message.fields.topic'),
				value: topic,
			});
		}

		if (category.guild.footer) {
			embed.setFooter({
				iconURL: guild.iconURL(),
				text: category.guild.footer,
			});
		}

		// TODO: add edit button (if topic or questions)
		// TODO: add close and claim buttons if enabled
		const pings = category.pingRoles.map(r => `<@&${r}>`).join(' ');
		const sent = await channel.send({
			content: getMessage('ticket.opening_message.content', {
				creator: interaction.user.toString(),
				staff: pings ? pings + ',' : '',
			}),
			embeds: [embed],
		});
		await sent.pin({ reason: 'Ticket opening message' });
		const pinned = channel.messages.cache.last();

		if (pinned.system) {
			pinned
				.delete({ reason: 'Cleaning up system message' })
				.catch(() => this.client.log.warn('Failed to delete system pin message'));
		}

		// TODO: referenced msg or ticket

		const data = {
			category: { connect: { id: categoryId } },
			createdBy: {
				connectOrCreate: {
					create: { id: interaction.user.id },
					where: { id: interaction.user.id },
				},
			},
			guild: { connect: { id: category.guild.id } },
			id: channel.id,
			number,
			openingMessage: sent.id,
			topic,
		};
		if (referencesTicket) data.referencesTicket = { connect: { id: referencesTicket } };
		let message;
		if (referencesMessage) message = this.client.prisma.archivedMessage.findUnique({ where: { id: referencesMessage } });
		if (message) data.referencesMessage = { connect: { id: referencesMessage } }; // only add if the message has been archived ^^
		if (answers) data.questionAnswers = { createMany: { data: answers } };
		const ticket = await this.client.prisma.ticket.create({ data });
		console.log(ticket);
		interaction.editReply({
			components: [],
			embeds: [],
		});
		// TODO: log channel
	}
};