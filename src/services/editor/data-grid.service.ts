import { inject, InjectionKey } from 'vue'
import {
    DataGridDataPointer, EntityPropertyDescriptor,
    EntityPropertyKey,
    EntityPropertyType, EntityPropertyValueSupportedCodeLanguage,
    QueryResult,
    StaticEntityProperties
} from '@/model/editor/data-grid'
import { QueryLanguage, UnexpectedError } from '@/model/lab'
import { QueryExecutor } from '@/services/editor/data-grid/query-executor'
import { QueryBuilder } from '@/services/editor/data-grid/query-builder'
import { EvitaQLQueryBuilder } from '@/services/editor/data-grid/evitaql-query-builder'
import { EvitaQLQueryExecutor } from '@/services/editor/data-grid/evitaql-query-executor'
import { LabService } from '@/services/lab.service'
import { GraphQLQueryBuilder } from '@/services/editor/data-grid/graphql-query-builder'
import { GraphQLQueryExecutor } from '@/services/editor/data-grid/graphql-query-executor'
import { EvitaDBClient } from '@/services/evitadb-client'
import { AttributeSchemaUnion, EntitySchema } from '@/model/evitadb'
import { GraphQLClient } from '@/services/graphql-client'
import { EntityPropertyValueFormatter } from '@/services/editor/data-grid/entity-property-value-formatter'
import { EntityPropertyValueRawFormatter } from '@/services/editor/data-grid/entity-property-value-raw-formatter'
import {
    EntityPropertyValueJsonFormatter
} from '@/services/editor/data-grid/entity-property-value-json-formatter'
import {
    EntityPropertyValueXmlFormatter
} from '@/services/editor/data-grid/entity-property-value-xml-formatter'

export const key: InjectionKey<DataGridService> = Symbol()

/**
 * Service for running the data grid console component.
 */
export class DataGridService {
    private readonly labService: LabService

    private readonly queryBuilders: Map<QueryLanguage, QueryBuilder> = new Map<QueryLanguage, QueryBuilder>()
    private readonly queryExecutors: Map<QueryLanguage, QueryExecutor> = new Map<QueryLanguage, QueryExecutor>()

    private readonly entityPropertyValueFormatters: Map<EntityPropertyValueSupportedCodeLanguage, EntityPropertyValueFormatter> = new Map<EntityPropertyValueSupportedCodeLanguage, EntityPropertyValueFormatter>()

    constructor(labService: LabService, evitaDBClient: EvitaDBClient, graphQLClient: GraphQLClient) {
        this.labService = labService

        this.queryBuilders.set(QueryLanguage.EvitaQL, new EvitaQLQueryBuilder(this.labService))
        this.queryExecutors.set(QueryLanguage.EvitaQL, new EvitaQLQueryExecutor(this.labService, evitaDBClient))

        this.queryBuilders.set(QueryLanguage.GraphQL, new GraphQLQueryBuilder(this.labService))
        this.queryExecutors.set(QueryLanguage.GraphQL, new GraphQLQueryExecutor(this.labService, graphQLClient))

        this.entityPropertyValueFormatters.set(EntityPropertyValueSupportedCodeLanguage.Raw, new EntityPropertyValueRawFormatter())
        this.entityPropertyValueFormatters.set(EntityPropertyValueSupportedCodeLanguage.Json, new EntityPropertyValueJsonFormatter())
        this.entityPropertyValueFormatters.set(EntityPropertyValueSupportedCodeLanguage.Xml, new EntityPropertyValueXmlFormatter())
    }

    /**
     * Builds query from arguments into desired language, executes it, and returns result.
     *
     * @param dataPointer points to collection where to fetch data from
     * @param language language of query, defines how query will be built and executed
     * @param filterBy filter by part of query, depends on language
     * @param orderBy order by part of query, depends on language
     * @param dataLocale locale of data in query, if undefined, only global data are returned
     * @param requiredData defines which data should be fetched from collection as entity fields
     * @param pageNumber page number of query result
     * @param pageSize page size of query result
     */
    async executeQuery(dataPointer: DataGridDataPointer,
                       language: QueryLanguage,
                       filterBy: string,
                       orderBy: string,
                       dataLocale: string | undefined,
                       requiredData: EntityPropertyKey[],
                       pageNumber: number,
                       pageSize: number): Promise<QueryResult> {
        const queryBuilder: QueryBuilder = this.getQueryBuilder(language)
        const queryExecutor: QueryExecutor = this.getQueryExecutor(language)

        const query: string = await queryBuilder.buildQuery(
            dataPointer,
            filterBy,
            orderBy,
            dataLocale,
            requiredData,
            pageNumber,
            pageSize
        )
        return queryExecutor.executeQuery(dataPointer, query)
    }

    /**
     * Builds order by clause from selected grid columns.
     *
     * @param dataPointer points to collection where to fetch data from
     * @param language language of query, defines how query will be built and executed
     * @param columns columns that represents by which entity properties we want to sort
     */
    async buildOrderByFromGridColumns(dataPointer: DataGridDataPointer, language: QueryLanguage, columns: any[]): Promise<string> {
        const entitySchema: EntitySchema = await this.labService.getEntitySchema(dataPointer.connection, dataPointer.catalogName, dataPointer.entityType)
        const queryBuilder: QueryBuilder = this.getQueryBuilder(language)

        const orderBy: string[] = []
        for (const column of columns) {
            const propertyKey: EntityPropertyKey = EntityPropertyKey.fromString(column.key)
            if (propertyKey.type === EntityPropertyType.Entity && propertyKey.name === StaticEntityProperties.PrimaryKey) {
                orderBy.push(queryBuilder.buildPrimaryKeyOrderBy(column.order))
            } else if (propertyKey.type === EntityPropertyType.Attributes) {
                const attributeSchema: AttributeSchemaUnion | undefined = Object.values(entitySchema.attributes)
                    .find(attributeSchema => attributeSchema.nameVariants.camelCase === propertyKey.name)
                if (attributeSchema == undefined) {
                    throw new UnexpectedError(undefined, `Entity ${entitySchema.name} does not have attribute ${propertyKey.name}.`)
                }

                orderBy.push(queryBuilder.buildAttributeOrderBy(attributeSchema, column.order))
            } else {
                throw new UnexpectedError(undefined, `Entity property ${column.key} is not supported to be sortable.`)
            }
        }

        return orderBy.join(', ')
    }

    /**
     * Build filter by clause to find parent entities by their primary key in the same collection as child entity.
     *
     * @param language language of query, defines how query will be built and executed
     * @param parentPrimaryKey primary key of parent entity
     */
    buildParentEntityFilterBy(language: QueryLanguage, parentPrimaryKey: number): string {
        return this.getQueryBuilder(language).buildParentEntityFilterBy(parentPrimaryKey)
    }

    /**
     * Builds filter by clause to find referenced entities by their primary keys in the same collection as successor entity.
     *
     * @param language language of query, defines how query will be built and executed
     * @param predecessorPrimaryKey primary key of predecessor entity
     */
    buildPredecessorEntityFilterBy(language: QueryLanguage, predecessorPrimaryKey: number): string {
        return this.getQueryBuilder(language).buildPredecessorEntityFilterBy(predecessorPrimaryKey)
    }

    /**
     * Builds filter by clause to find referenced entities by their primary keys in a referenced collection.
     *
     * @param language language of query, defines how query will be built and executed
     * @param referencedPrimaryKeys primary keys of referenced entities
     */
    buildReferencedEntityFilterBy(language: QueryLanguage, referencedPrimaryKeys: number[]): string {
        return this.getQueryBuilder(language).buildReferencedEntityFilterBy(referencedPrimaryKeys)
    }

    /**
     * Returns a list of locales in which data are stored in given collection.
     */
    async getDataLocales(dataPointer: DataGridDataPointer): Promise<string[]> {
        const entitySchema: EntitySchema = await this.labService.getEntitySchema(dataPointer.connection, dataPointer.catalogName, dataPointer.entityType)
        return entitySchema.locales
    }

    /**
     * Builds a list of all possible entity properties for entities of given schema.
     */
    async getEntityPropertyDescriptors(dataPointer: DataGridDataPointer): Promise<EntityPropertyDescriptor[]> {
        const entitySchema: EntitySchema = await this.labService.getEntitySchema(dataPointer.connection, dataPointer.catalogName, dataPointer.entityType)
        const descriptors: EntityPropertyDescriptor[] = []
        descriptors.push(new EntityPropertyDescriptor(
            EntityPropertyType.Entity,
            EntityPropertyKey.entity(StaticEntityProperties.PrimaryKey),
            'Primary key',
            'Primary key',
            undefined,
            []
        ))
        if (entitySchema.withHierarchy) {
            descriptors.push(new EntityPropertyDescriptor(
                EntityPropertyType.Entity,
                EntityPropertyKey.entity(StaticEntityProperties.ParentPrimaryKey),
                'Parent',
                'Parent',
                undefined,
                []
            ))
        }
        if (entitySchema.locales.length > 0) {
            descriptors.push(new EntityPropertyDescriptor(
                EntityPropertyType.Entity,
                EntityPropertyKey.entity(StaticEntityProperties.Locales),
                'Locales',
                'Locales',
                undefined,
                []
            ))
            descriptors.push(new EntityPropertyDescriptor(
                EntityPropertyType.Entity,
                EntityPropertyKey.entity(StaticEntityProperties.AllLocales),
                'All locales',
                'All locales',
                undefined,
                []
            ))
        }
        if (entitySchema.withPrice) {
            descriptors.push(new EntityPropertyDescriptor(
                EntityPropertyType.Entity,
                EntityPropertyKey.entity(StaticEntityProperties.PriceInnerRecordHandling),
                'Price inner record handling',
                'Price inner record handling',
                undefined,
                []
            ))
        }

        for (const attributeSchema of Object.values(entitySchema.attributes)) {
            descriptors.push(new EntityPropertyDescriptor(
                EntityPropertyType.Attributes,
                EntityPropertyKey.attributes(attributeSchema.nameVariants.camelCase),
                attributeSchema.name,
                attributeSchema.name,
                attributeSchema,
                []
            ))
        }

        for (const associatedDataSchema of Object.values(entitySchema.associatedData)) {
            descriptors.push(new EntityPropertyDescriptor(
                EntityPropertyType.AssociatedData,
                EntityPropertyKey.associatedData(associatedDataSchema.nameVariants.camelCase),
                associatedDataSchema.name,
                associatedDataSchema.name,
                associatedDataSchema,
                []
            ))
        }
        for (const referenceSchema of Object.values(entitySchema.references)) {
            descriptors.push(new EntityPropertyDescriptor(
                EntityPropertyType.References,
                EntityPropertyKey.references(referenceSchema.nameVariants.camelCase),
                referenceSchema.name,
                referenceSchema.name,
                referenceSchema,
                Object.values(referenceSchema.attributes).map(attributeSchema => {
                    return new EntityPropertyDescriptor(
                        EntityPropertyType.ReferenceAttributes,
                        EntityPropertyKey.referenceAttributes(referenceSchema.nameVariants.camelCase, attributeSchema.nameVariants.camelCase),
                        attributeSchema.name,
                        `${referenceSchema.name}: ${attributeSchema.name}`,
                        attributeSchema,
                        []
                    )
                })
            ))
        }

        return descriptors
    }

    /**
     * Formats given value into string representation in given language. If it fails, it will use fallback formatter.
     *
     * @param value raw value to be formatted into string into given language
     * @param language desired language of formatted value
     * @param prettyPrint if value should be pretty printed
     */
    formatEntityPropertyValue(value: any, language: EntityPropertyValueSupportedCodeLanguage, prettyPrint: boolean = false): string {
        // todo lho maybe markdown pretty printing logic should be here as well
        const formatter: EntityPropertyValueFormatter | undefined = this.entityPropertyValueFormatters.get(language)
        if (formatter == undefined) {
            throw new UnexpectedError(undefined, `Property value formatter for language ${language} is not registered.`)
        }
        return formatter.format(value, prettyPrint)
    }

    private getQueryBuilder(language: QueryLanguage): QueryBuilder {
        const queryBuilder: QueryBuilder | undefined = this.queryBuilders.get(language)
        if (queryBuilder == undefined) {
            throw new UnexpectedError(undefined, `Query builder for language ${language} is not registered.`)
        }
        return queryBuilder
    }

    private getQueryExecutor(language: QueryLanguage): QueryExecutor {
        const queryExecutor: QueryExecutor | undefined = this.queryExecutors.get(language)
        if (queryExecutor == undefined) {
            throw new UnexpectedError(undefined, `Query executor for language ${language} is not registered.`)
        }
        return queryExecutor
    }
}

export const useDataGridService = (): DataGridService => {
    return inject(key) as DataGridService
}
